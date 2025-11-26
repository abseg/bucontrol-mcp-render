/**
 * Client WebSocket Connection for V2 Bridge
 * Single connection to Q-SYS bridge used by all transports
 * Compatible with websocket-bridge-v2.js server
 */
import { io } from 'socket.io-client';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json
let APP_VERSION = '2.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  APP_VERSION = pkg.version || '2.1.0';
} catch (e) {
  // Fallback to hardcoded version
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'bucontrol-ws-client' }
});

class WebSocketManager {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.isIdentified = false;
    this.reconnectAttempt = 0;

    // Server-assigned identity (from client:identify:success)
    this.serverIdentity = {
      socketId: null,
      clientId: null,
      serverTime: null,
      transport: null,
      ipAddress: null,
      connectedAt: null
    };

    // Latency tracking
    this.latency = {
      current: 0,
      average: 0,
      samples: []
    };

    // Connection health monitoring
    // Server sends ping every 25s and expects pong within 60s
    // Server disconnects client if no ping received for 90s
    this.connectionHealth = {
      lastPingSent: 0,
      lastPongReceived: 0,
      missedPongs: 0,
      maxMissedPongs: 3,       // Reconnect after 3 missed pongs (75s without response)
      pongTimeout: 30000       // Consider pong missed if not received within 30s
    };

    // Connection monitor interval reference
    this.connectionMonitorInterval = null;

        // Controller status
    this.controllerStatus = {
      connected: false,
      health: 'unknown',
      lastUpdate: 0
    };

    // Component IDs (discovered)
    this.components = {
      videoWall: null,
      hdmiDisplay: null,
      gpio: null,
      hdmiDecoder: null,
      lighting: null,
      mixer: null
    };

    // Discovered components list
    this.discoveredComponents = { list: {}, watched: {} };

    // State cache with TTL
    this.state = {
      hardwareState: null,
      connectedSources: null,
      screenPower: null,
      privacyGlass: null,
      didoOutput: null,
      lightingLevel: null,
      volumeLevel: null,
      timestamp: 0,
      TTL: 5000
    };

    // Listeners for state changes
    this.stateListeners = new Set();

    // Listeners for controller status changes
    this.statusListeners = new Set();

    // Config (set during init)
    this.config = null;

    // Heartbeat interval reference (for cleanup)
    this.heartbeatInterval = null;
  }

  /**
   * Initialize connection with config
   */
  async init(config) {
    this.config = config;
    const url = `http://${config.websocketHost}:${config.websocketPort}`;

    return new Promise((resolve, reject) => {
      logger.info({ url }, 'Connecting to WebSocket bridge V2');

      const socketOptions = {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: config.reconnectionDelayBase || 1000,
        reconnectionDelayMax: config.reconnectionDelayMax || 5000,
        reconnectionAttempts: config.reconnectionAttempts || Infinity,
        timeout: config.connectionTimeout || 20000
      };

      // Add authentication token if configured
      if (config.authToken) {
        socketOptions.auth = { token: config.authToken };
        logger.info('Using authentication token');
      }

      // Use SOCKS5 proxy for Tailscale
      if (process.env.TAILSCALE_AUTHKEY) {
        const proxyUrl = process.env.TAILSCALE_SOCKS_PROXY || 'socks5://127.0.0.1:1055';
        logger.info({ proxyUrl }, 'Using Tailscale SOCKS5 proxy');
        socketOptions.agent = new SocksProxyAgent(proxyUrl);
      }

      this.socket = io(url, socketOptions);

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, config.connectionTimeout || 20000);

      this.socket.on('connect', async () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.reconnectAttempt = 0;
        

        // Reset connection health on new connection
        this.connectionHealth.lastPongReceived = Date.now();
        this.connectionHealth.missedPongs = 0;

        logger.info('Connected to WebSocket bridge V2');

        try {
          await this.identify();
          const discovery = await this.discoverComponents();

          // Fallback: if discovery fails or returns 0 components, wait for digitaltwin:ready
          if (!discovery.success || discovery.componentCount === 0) {
            logger.info('Initial discovery returned 0 components, waiting for digitaltwin:ready...');
            await new Promise(r => {
              this.socket.once('digitaltwin:ready', () => {
                logger.info('Received digitaltwin:ready event');
                r();
              });
              setTimeout(() => {
                logger.warn('digitaltwin:ready timeout, retrying discovery anyway');
                r();
              }, 30000);
            });
            await this.discoverComponents();
          }

          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.socket.on('disconnect', (reason) => {
        this.isConnected = false;
        this.isIdentified = false;
        this.controllerStatus.connected = false;
        this.controllerStatus.health = 'disconnected';
        logger.warn({ reason }, 'Disconnected from WebSocket');
        this.socket.removeAllListeners('component:state');
        this.socket.removeAllListeners('control:update');
        this.notifyStatusChange();
      });

      this.socket.on('connect_error', (e) => {
        clearTimeout(timeout);
        logger.error({ error: e.message }, 'Connection error');
        reject(e);
      });

      this.socket.on('reconnect', async (attemptNumber) => {
        logger.info({ attemptNumber }, 'Reconnected to WebSocket');
        this.isConnected = true;

        // Reset connection health on reconnection
        this.connectionHealth.lastPongReceived = Date.now();
        this.connectionHealth.missedPongs = 0;

        try {
          await this.identify();
          await this.discoverComponents();
          logger.info('Re-identified after reconnection');
        } catch (e) {
          logger.error({ error: e.message }, 'Failed to re-identify after reconnection');
        }
      });

      this.socket.on('reconnect_attempt', (attemptNumber) => {
        this.reconnectAttempt = attemptNumber;
        logger.debug({ attemptNumber }, 'Attempting to reconnect');
      });

      this.socket.on('reconnect_error', (e) => {
        logger.warn({ error: e.message }, 'Reconnection error');
      });

      // Handle pong response for latency and health tracking
      this.socket.on('pong', (data) => {
        // Update connection health - server responded
        this.connectionHealth.lastPongReceived = Date.now();
        this.connectionHealth.missedPongs = 0;

        if (data.clientTimestamp) {
          const latency = Date.now() - data.clientTimestamp;
          this.latency.current = latency;
          this.latency.samples.push(latency);
          // Keep only last 10 samples
          if (this.latency.samples.length > 10) {
            this.latency.samples.shift();
          }
          this.latency.average = Math.round(
            this.latency.samples.reduce((a, b) => a + b, 0) / this.latency.samples.length
          );
          logger.debug({ latency, average: this.latency.average }, 'Latency measured');
        }
      });

      // Handle controller status updates
      this.socket.on('controller:status', (data) => {
        logger.info({ controllerId: data.controllerId, status: data.status, health: data.health }, 'Controller status update');
        this.controllerStatus = {
          connected: data.connected,
          health: data.health || (data.connected ? 'healthy' : 'disconnected'),
          status: data.status,
          lastUpdate: Date.now()
        };
        this.notifyStatusChange();
      });

      // Handle digitaltwin:ready for late initialization
      this.socket.on('digitaltwin:ready', (data) => {
        logger.info({ controllers: data.controllers, totalComponents: data.totalComponents }, 'Digital twin ready');
        // Re-discover components if we have none
        if (Object.keys(this.discoveredComponents.list).length === 0) {
          this.discoverComponents().catch(e => {
            logger.error({ error: e.message }, 'Failed to discover components on digitaltwin:ready');
          });
        }
      });

      // Handle system:ready
      this.socket.on('system:ready', (data) => {
        logger.info({ controllers: data.controllers?.length || 0 }, 'System ready');
      });

      // Heartbeat to keep SOCKS proxy connection alive (ping only, no redundant subscribe)
      this.heartbeatInterval = setInterval(() => {
        if (this.isConnected && this.socket) {
          this.connectionHealth.lastPingSent = Date.now();
          this.socket.emit('ping', { timestamp: Date.now() });
        }
      }, 25000);

      // Connection health monitor - check for stale connections
      this.connectionMonitorInterval = setInterval(() => {
        if (!this.isConnected) return;

        const now = Date.now();
        const timeSinceLastPong = now - this.connectionHealth.lastPongReceived;

        // If we've sent a ping but haven't received pong within timeout, count it as missed
        if (this.connectionHealth.lastPingSent > this.connectionHealth.lastPongReceived &&
            timeSinceLastPong > this.connectionHealth.pongTimeout) {
          this.connectionHealth.missedPongs++;
          logger.warn({
            missedPongs: this.connectionHealth.missedPongs,
            timeSinceLastPong: Math.round(timeSinceLastPong / 1000)
          }, 'Missed pong response');

          // If we've missed too many pongs, force reconnect
          if (this.connectionHealth.missedPongs >= this.connectionHealth.maxMissedPongs) {
            logger.error({
              missedPongs: this.connectionHealth.missedPongs,
              timeSinceLastPong: Math.round(timeSinceLastPong / 1000)
            }, 'Connection stale - forcing reconnect');
            this.reconnect().catch(e => {
              logger.error({ error: e.message }, 'Auto-reconnect failed');
            });
          }
        }
      }, 30000); // Check every 30 seconds

      // Handle state updates
      this.socket.on('control:update', (data) => this.handleControlUpdate(data));
      this.socket.on('component:state', (data) => this.handleComponentState(data));
    });
  }

  identify() {
    return new Promise((resolve, reject) => {
      const identifyTimeout = this.config?.identifyTimeout || 5000;
      const timeout = setTimeout(() => reject(new Error('Identification timeout')), identifyTimeout);

      this.socket.once('client:identify:success', (data) => {
        clearTimeout(timeout);
        this.isIdentified = true;

        // Store server-assigned identity
        this.serverIdentity = {
          socketId: data.socketId,
          clientId: data.clientId,
          serverTime: data.serverTime,
          transport: data.connection?.transport,
          ipAddress: data.connection?.ipAddress,
          connectedAt: data.connection?.connectedAt
        };

        logger.info({
          clientId: data.clientId,
          socketId: data.socketId,
          transport: this.serverIdentity.transport
        }, 'Client identified by server');

        resolve(data);
      });

      this.socket.emit('client:identify', {
        platform: 'mcp-unified',
        device: process.env.TAILSCALE_AUTHKEY ? 'cloud' : 'server',
        osVersion: process.platform,
        appVersion: APP_VERSION,
        buildNumber: process.env.BUILD_NUMBER || '1',
        deviceName: process.env.DEVICE_NAME || 'BUControl MCP Unified Server'
      });
    });
  }

  discoverComponents() {
    return new Promise((resolve) => {
      const discoveryTimeout = this.config?.discoveryTimeout || 10000;
      const timeout = setTimeout(() => resolve({ success: false, componentCount: 0 }), discoveryTimeout);

      this.socket.once('controller:state', (data) => {
        clearTimeout(timeout);

        if (!data.components) {
          return resolve({ success: false, componentCount: 0 });
        }

        // Update controller status
        this.controllerStatus.connected = data.connected !== false;
        this.controllerStatus.health = data.connected !== false ? 'healthy' : 'disconnected';
        this.controllerStatus.lastUpdate = Date.now();

        // Store discovered components
        Object.entries(data.components).forEach(([id, comp]) => {
          this.discoveredComponents.list[comp.name] = {
            id,
            name: comp.name,
            controls: comp.controls || {}
          };
        });

        const entries = Object.entries(data.components);

        // Find known components
        const patterns = [
          ['videoWall', ['BUControl', 'Video Wall']],
          ['hdmiDisplay', ['Generic_HDMI_Display']],
          ['gpio', ['GPIO_Out_Core-Maktabi']],
          ['hdmiDecoder', ['HDMI_I/ODecoder']],
          ['lighting', ['LutronLEAPZone']],
          ['mixer', ['Mixer_8x8_2']]
        ];

        patterns.forEach(([key, names]) => {
          const found = entries.find(([, c]) =>
            names.some(p => c.name.includes(p))
          );
          if (found) {
            this.components[key] = found[0];
            logger.info({ component: key, id: found[0] }, 'Component found');
          }
        });

        // Subscribe only to the known components we actually use
        // MCP is request/response - we don't need ALL control updates, just the ones we query
        Object.values(this.components).filter(Boolean).forEach(id => {
          this.socket.emit('component:subscribe', {
            controllerId: this.config.controllerId,
            componentId: id
          });
        });

        resolve({ success: true, componentCount: entries.length });
      });

      this.socket.emit('controller:subscribe', {
        controllerId: this.config.controllerId
      });
    });
  }

  handleControlUpdate(data) {
    const { controlId, control } = data;

    const map = {
      'HardwareState': 'hardwareState',
      'hdmi.enabled.button': 'screenPower',
      'pin.8.digital.out': 'privacyGlass',
      'hdmi.out.1.select.hdmi.1': 'didoOutput',
      'ZoneDimLevel1': 'lightingLevel',
      'output.1.gain': 'volumeLevel'
    };

    if (controlId === 'ConnectedSources') {
      try {
        this.state.connectedSources = JSON.parse(control.string || control.value).sources;
      } catch (e) {}
    } else if (map[controlId]) {
      this.state[map[controlId]] = control.value;
    }

    this.state.timestamp = Date.now();
    this.notifyStateChange();
  }

  handleComponentState(data) {
    const c = data.component?.controls;
    if (!c) return;

    if (c.HardwareState) this.state.hardwareState = c.HardwareState.value;
    if (c.ConnectedSources) {
      try {
        this.state.connectedSources = JSON.parse(c.ConnectedSources.string || c.ConnectedSources.value).sources;
      } catch (e) {}
    }
    if (c['hdmi.enabled.button']) this.state.screenPower = c['hdmi.enabled.button'].value;
    if (c['pin.8.digital.out']) this.state.privacyGlass = c['pin.8.digital.out'].value;
    if (c['hdmi.out.1.select.hdmi.1']) this.state.didoOutput = c['hdmi.out.1.select.hdmi.1'].value;
    if (c.ZoneDimLevel1) this.state.lightingLevel = c.ZoneDimLevel1.value;
    if (c['output.1.gain']) this.state.volumeLevel = c['output.1.gain'].value;

    this.state.timestamp = Date.now();
    this.notifyStateChange();
  }

  notifyStateChange() {
    for (const listener of this.stateListeners) {
      try {
        listener(this.state);
      } catch (e) {
        logger.error({ error: e.message }, 'State listener error');
      }
    }
  }

  notifyStatusChange() {
    for (const listener of this.statusListeners) {
      try {
        listener(this.controllerStatus);
      } catch (e) {
        logger.error({ error: e.message }, 'Status listener error');
      }
    }
  }

  onStateChange(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onStatusChange(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Get current state (refresh if stale)
   */
  async getState() {
    if (Date.now() - this.state.timestamp > this.state.TTL) {
      this.socket.emit('controller:subscribe', {
        controllerId: this.config.controllerId
      });
      await new Promise(r => setTimeout(r, 100));
    }
    return this.state;
  }

  /**
   * Get latency info
   */
  getLatency() {
    return { ...this.latency };
  }

  /**
   * Get controller status
   */
  getControllerStatus() {
    return { ...this.controllerStatus };
  }

  /**
   * Send control command
   * Fixed: Properly cleans up event listeners on timeout to prevent memory leaks
   */
  sendControl(componentKey, controlId, value) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.isIdentified) {
        return reject(new Error('Not connected'));
      }

      const componentId = typeof componentKey === 'string' && componentKey.includes('-')
        ? componentKey  // Already a component ID
        : this.components[componentKey];

      if (!componentId) {
        return reject(new Error(`Component not found: ${componentKey}`));
      }

      const transactionId = `mcp-${Date.now()}-${uuidv4().slice(0, 8)}`;
      const commandTimeout = this.config?.commandTimeout || 10000;

      // Cleanup function to remove listeners
      const cleanup = () => {
        this.socket.off('control:set:success', onSuccess);
        this.socket.off('control:set:error', onError);
      };

      const timeout = setTimeout(() => {
        cleanup(); // CRITICAL: Clean up listeners on timeout
        reject(new Error('Command timeout'));
      }, commandTimeout);

      const onSuccess = (d) => {
        if (d.transactionId === transactionId) {
          clearTimeout(timeout);
          cleanup();
          resolve({ success: true, transactionId });
        }
      };

      const onError = (d) => {
        if (d.transactionId === transactionId) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(d.message || d.error || 'Command failed'));
        }
      };

      this.socket.on('control:set:success', onSuccess);
      this.socket.on('control:set:error', onError);

      this.socket.emit('control:set', {
        controllerId: this.config.controllerId,
        componentId,
        controlId,
        value,
        transactionId
      });
    });
  }

  /**
   * Find component by name
   */
  findComponent(name) {
    const match = Object.keys(this.discoveredComponents.list).find(n =>
      n.toLowerCase().includes(name.toLowerCase())
    );
    return match ? this.discoveredComponents.list[match] : null;
  }

  /**
   * Subscribe to a component for state updates (on-demand)
   * Only subscribes if not already watching this component
   * @param {string} componentId - Component ID to subscribe to
   * @returns {Promise<object>} Component state after subscription
   */
  async subscribeToComponent(componentId) {
    if (!this.isConnected || !this.isIdentified) {
      throw new Error('Not connected');
    }

    // Check if already subscribed
    if (this.discoveredComponents.watched[componentId]) {
      logger.debug({ componentId }, 'Component already subscribed');
      return this.discoveredComponents.watched[componentId];
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Component subscribe timeout'));
      }, this.config?.commandTimeout || 10000);

      // Listen for component state response
      const onState = (data) => {
        if (data.componentId === componentId || data.component?.id === componentId) {
          clearTimeout(timeout);
          this.socket.off('component:state', onState);

          // Mark as watched
          this.discoveredComponents.watched[componentId] = {
            subscribedAt: Date.now(),
            state: data.component || data
          };

          logger.info({ componentId }, 'Subscribed to component');
          resolve(data.component || data);
        }
      };

      this.socket.on('component:state', onState);

      this.socket.emit('component:subscribe', {
        controllerId: this.config.controllerId,
        componentId
      });
    });
  }

  /**
   * Subscribe to a specific control for updates (on-demand)
   * @param {string} componentId - Component ID
   * @param {string} controlId - Control ID to subscribe to
   * @returns {Promise<object>} Control state after subscription
   */
  async subscribeToControl(componentId, controlId) {
    if (!this.isConnected || !this.isIdentified) {
      throw new Error('Not connected');
    }

    const watchKey = `${componentId}:${controlId}`;

    // Check if already subscribed
    if (this.discoveredComponents.watched[watchKey]) {
      logger.debug({ componentId, controlId }, 'Control already subscribed');
      return this.discoveredComponents.watched[watchKey];
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Control subscribe timeout'));
      }, this.config?.commandTimeout || 10000);

      // Listen for control update response
      const onUpdate = (data) => {
        if (data.componentId === componentId && data.controlId === controlId) {
          clearTimeout(timeout);
          this.socket.off('control:update', onUpdate);

          // Mark as watched
          this.discoveredComponents.watched[watchKey] = {
            subscribedAt: Date.now(),
            control: data.control || data
          };

          logger.info({ componentId, controlId }, 'Subscribed to control');
          resolve(data.control || data);
        }
      };

      this.socket.on('control:update', onUpdate);

      this.socket.emit('control:subscribe', {
        controllerId: this.config.controllerId,
        componentId,
        controlId
      });
    });
  }

  /**
   * Get connection health status
   */
  getConnectionHealth() {
    const now = Date.now();
    const timeSinceLastPong = now - this.connectionHealth.lastPongReceived;

    let health = 'healthy';
    if (!this.isConnected) {
      health = 'disconnected';
    } else if (this.connectionHealth.missedPongs >= 2) {
      health = 'degraded';
    } else if (timeSinceLastPong > 60000) {
      health = 'stale';
    }

    return {
      health,
      connected: this.isConnected,
      identified: this.isIdentified,
      lastPingSent: this.connectionHealth.lastPingSent,
      lastPongReceived: this.connectionHealth.lastPongReceived,
      timeSinceLastPong: Math.round(timeSinceLastPong / 1000),
      missedPongs: this.connectionHealth.missedPongs,
      latency: this.latency.average
    };
  }

  /**
   * Disconnect
   */
  disconnect() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.connectionMonitorInterval) {
      clearInterval(this.connectionMonitorInterval);
      this.connectionMonitorInterval = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.isConnected = false;
      this.isIdentified = false;
    }
  }

  /**
   * Force reconnect
   */
  async reconnect() {
    this.disconnect();
    await this.init(this.config);
  }
}

// Singleton instance
const wsManager = new WebSocketManager();

export default wsManager;
export { WebSocketManager };
