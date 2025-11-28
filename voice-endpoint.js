/**
 * BUControl VAPI Voice Endpoint
 * Voice-optimized webhook handler for VAPI assistants
 *
 * Features:
 * - Brief "Done" style confirmations
 * - 5-second state cache
 * - Idempotent commands with state checks
 * - Separate WebSocket connection
 */

import { io } from 'socket.io-client';
import { SocksProxyAgent } from 'socks-proxy-agent';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import http from 'http';
import https from 'https';

// Proxy-aware fetch for Tailscale URLs
async function proxyFetch(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 10000
    };

    // Use SOCKS proxy if Tailscale is configured
    if (process.env.TAILSCALE_AUTHKEY) {
      const proxyUrl = process.env.TAILSCALE_SOCKS_PROXY || 'socks5://127.0.0.1:1055';
      options.agent = new SocksProxyAgent(proxyUrl);
    }

    const req = httpModule.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          arrayBuffer: async () => buffer
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// Grab a single frame from an MJPEG stream
async function grabMjpegFrame(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 10000
    };

    // Use SOCKS proxy if Tailscale is configured
    if (process.env.TAILSCALE_AUTHKEY) {
      const proxyUrl = process.env.TAILSCALE_SOCKS_PROXY || 'socks5://127.0.0.1:1055';
      options.agent = new SocksProxyAgent(proxyUrl);
    }

    const req = httpModule.request(options, (res) => {
      let buffer = Buffer.alloc(0);
      let foundStart = false;
      let frameComplete = false;

      res.on('data', chunk => {
        if (frameComplete) return;

        buffer = Buffer.concat([buffer, chunk]);

        // Look for JPEG markers
        // SOI (Start of Image): FF D8
        // EOI (End of Image): FF D9
        if (!foundStart) {
          const soiIndex = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
          if (soiIndex !== -1) {
            buffer = buffer.slice(soiIndex);
            foundStart = true;
          }
        }

        if (foundStart) {
          const eoiIndex = buffer.indexOf(Buffer.from([0xFF, 0xD9]));
          if (eoiIndex !== -1) {
            // Extract complete JPEG frame
            const frame = buffer.slice(0, eoiIndex + 2);
            frameComplete = true;
            req.destroy(); // Close connection
            resolve({
              ok: true,
              status: 200,
              arrayBuffer: async () => frame
            });
          }
        }

        // Safety limit - don't buffer too much
        if (buffer.length > 5 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Frame too large'));
        }
      });

      res.on('end', () => {
        if (!frameComplete) {
          reject(new Error('Stream ended without complete frame'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Stream timeout'));
    });
    req.end();
  });
}

// Initialize Gemini AI (lazy - only when needed)
let genAI = null;
function getGeminiModel() {
  if (!genAI && process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI?.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'bucontrol-voice' }
});

// Source name mapping
const SOURCE_NAMES = {
  1: 'Laptop',
  2: 'ClickShare',
  3: 'AppleTV',
  4: 'Conference'
};

const SOURCE_IDS = {
  'laptop': 1,
  'clickshare': 2,
  'appletv': 3,
  'apple tv': 3,
  'conference': 4,
  'conf': 4
};

// Volume level mapping (dB values)
const VOLUME_MAP = {
  mute: -100,
  low: -40,
  medium: -20,
  high: 0,
  max: 10
};

/**
 * Voice endpoint state and connection manager
 */
class VoiceEndpoint {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.isConnected = false;
    this.isIdentified = false;

    // Component IDs (discovered)
    this.components = {
      videoWall: null,
      hdmiDisplay: null,
      gpio: null,
      hdmiDecoder: null,
      lighting: null,
      mixer: null
    };

    // State cache with 5-second TTL
    this.cache = {
      state: {
        screen: false,
        source: 1,
        lights: 100,
        volume: -20,
        glass: false,
        dido: false,
        connectedSources: []
      },
      timestamp: 0,
      TTL: 5000
    };
  }

  /**
   * Initialize WebSocket connection
   */
  async init() {
    const url = `http://${this.config.websocketHost}:${this.config.websocketPort}`;

    return new Promise((resolve, reject) => {
      logger.info({ url }, 'Voice endpoint connecting to WebSocket');

      const socketOptions = {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
        timeout: this.config.connectionTimeout || 20000
      };

      // Use SOCKS5 proxy for Tailscale
      if (process.env.TAILSCALE_AUTHKEY) {
        const proxyUrl = process.env.TAILSCALE_SOCKS_PROXY || 'socks5://127.0.0.1:1055';
        logger.info({ proxyUrl }, 'Voice using Tailscale SOCKS5 proxy');
        socketOptions.agent = new SocksProxyAgent(proxyUrl);
      }

      this.socket = io(url, socketOptions);

      const timeout = setTimeout(() => {
        reject(new Error('Voice connection timeout'));
      }, this.config.connectionTimeout || 20000);

      this.socket.on('connect', async () => {
        clearTimeout(timeout);
        this.isConnected = true;
        logger.info('Voice endpoint connected');

        try {
          await this.identify();
          await this.discoverComponents();
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.socket.on('disconnect', (reason) => {
        this.isConnected = false;
        this.isIdentified = false;
        logger.warn({ reason }, 'Voice endpoint disconnected');
      });

      this.socket.on('connect_error', (e) => {
        clearTimeout(timeout);
        logger.error({ error: e.message }, 'Voice connection error');
        reject(e);
      });

      this.socket.on('reconnect', async () => {
        this.isConnected = true;
        try {
          await this.identify();
          await this.discoverComponents();
        } catch (e) {
          logger.error({ error: e.message }, 'Voice reconnect failed');
        }
      });

      // Heartbeat to keep connection alive (critical for SOCKS proxy)
      setInterval(() => {
        if (this.isConnected && this.socket) {
          this.socket.emit('ping', { timestamp: Date.now() });
          if (this.isIdentified) {
            this.socket.emit('controller:subscribe', {
              controllerId: this.config.controllerId
            });
          }
          logger.debug('Voice heartbeat sent');
        }
      }, 25000);

      // Handle state updates
      this.socket.on('control:update', (data) => {
        this.handleControlUpdate(data);
      });

      this.socket.on('component:state', (data) => {
        this.handleComponentState(data);
      });
    });
  }

  identify() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Identify timeout')), 5000);

      this.socket.once('client:identify:success', (data) => {
        clearTimeout(timeout);
        this.isIdentified = true;
        logger.info({ clientId: data.clientId }, 'Voice client identified');
        resolve(data);
      });

      this.socket.emit('client:identify', {
        platform: 'vapi-voice',
        device: 'render',
        osVersion: process.platform,
        appVersion: '1.0.0',
        buildNumber: '1',
        deviceName: 'BUControl VAPI Voice Server'
      });
    });
  }

  discoverComponents() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ success: false }), 10000);

      this.socket.once('controller:state', (data) => {
        clearTimeout(timeout);

        if (!data.components) {
          return resolve({ success: false });
        }

        const entries = Object.entries(data.components);

        // Find components
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
            logger.info({ component: key, id: found[0] }, 'Voice found component');
          }
        });

        // Subscribe to components
        Object.values(this.components).filter(Boolean).forEach(id => {
          this.socket.emit('component:subscribe', {
            controllerId: this.config.controllerId,
            componentId: id
          });
        });

        resolve({ success: true, count: entries.length });
      });

      this.socket.emit('controller:subscribe', {
        controllerId: this.config.controllerId
      });
    });
  }

  handleControlUpdate(data) {
    const { controlId, control } = data;

    switch (controlId) {
      case 'HardwareState':
        // Parse hardware state to extract source
        const stateStr = control.string || String(control.value);
        const sourceMatch = stateStr.match(/W1S(\d)/);
        if (sourceMatch) {
          this.cache.state.source = parseInt(sourceMatch[1]);
        }
        break;

      case 'ConnectedSources':
        try {
          const parsed = JSON.parse(control.string || control.value);
          this.cache.state.connectedSources = parsed.sources || [];
        } catch (e) {}
        break;

      case 'hdmi.enabled.button':
        this.cache.state.screen = control.value === 1;
        break;

      case 'pin.8.digital.out':
        this.cache.state.glass = control.value === 1;
        break;

      case 'hdmi.out.1.select.hdmi.1':
        this.cache.state.dido = control.value === 1;
        break;

      case 'ZoneDimLevel1':
        this.cache.state.lights = control.value;
        break;

      case 'output.1.gain':
        this.cache.state.volume = control.value;
        break;
    }

    this.cache.timestamp = Date.now();
  }

  handleComponentState(data) {
    const c = data.component?.controls;
    if (!c) return;

    if (c.HardwareState) {
      const stateStr = c.HardwareState.string || String(c.HardwareState.value);
      const sourceMatch = stateStr.match(/W1S(\d)/);
      if (sourceMatch) {
        this.cache.state.source = parseInt(sourceMatch[1]);
      }
    }

    if (c.ConnectedSources) {
      try {
        const parsed = JSON.parse(c.ConnectedSources.string || c.ConnectedSources.value);
        this.cache.state.connectedSources = parsed.sources || [];
      } catch (e) {}
    }

    if (c['hdmi.enabled.button']) {
      this.cache.state.screen = c['hdmi.enabled.button'].value === 1;
    }

    if (c['pin.8.digital.out']) {
      this.cache.state.glass = c['pin.8.digital.out'].value === 1;
    }

    if (c['hdmi.out.1.select.hdmi.1']) {
      this.cache.state.dido = c['hdmi.out.1.select.hdmi.1'].value === 1;
    }

    if (c.ZoneDimLevel1) {
      this.cache.state.lights = c.ZoneDimLevel1.value;
    }

    if (c['output.1.gain']) {
      this.cache.state.volume = c['output.1.gain'].value;
    }

    this.cache.timestamp = Date.now();
  }

  /**
   * Get cached state (refresh if stale)
   */
  async getState() {
    if (Date.now() - this.cache.timestamp > this.cache.TTL) {
      // Request fresh state
      this.socket.emit('controller:subscribe', {
        controllerId: this.config.controllerId
      });
      // Small delay to allow state to arrive
      await new Promise(r => setTimeout(r, 100));
    }
    return this.cache.state;
  }

  /**
   * Send control command
   */
  sendControl(componentKey, controlId, value) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.isIdentified) {
        return reject(new Error('Not connected'));
      }

      const componentId = this.components[componentKey];
      if (!componentId) {
        return reject(new Error('Component not found'));
      }

      const transactionId = `voice-${Date.now()}-${uuidv4().slice(0, 8)}`;
      const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);

      const onSuccess = (d) => {
        if (d.transactionId === transactionId) {
          clearTimeout(timeout);
          this.socket.off('control:set:success', onSuccess);
          this.socket.off('control:set:error', onError);
          resolve({ success: true });
        }
      };

      const onError = (d) => {
        if (d.transactionId === transactionId) {
          clearTimeout(timeout);
          this.socket.off('control:set:success', onSuccess);
          this.socket.off('control:set:error', onError);
          reject(new Error(d.message || 'Failed'));
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
   * Tool handlers
   */
  async handleTool(name, args) {
    switch (name) {
      case 'room_status':
        return this.roomStatus();

      case 'set_source':
        return this.setSource(args);

      case 'screen_power':
        return this.screenPower(args);

      case 'privacy_glass':
        return this.privacyGlass(args);

      case 'set_lights':
        return this.setLights(args);

      case 'set_volume':
        return this.setVolume(args);

      case 'dido_output':
        return this.didoOutput(args);

      case 'list_sources':
        return this.listSources();

      case 'set_layout':
        return this.setLayout(args);

      case 'describe_sources':
        return this.describeSources(args);

      case 'get_help':
        return this.getHelp();

      default:
        throw new Error('Unknown command');
    }
  }

  async getHelp() {
    return `I control the BUControl AV system. Here's what I can do:

VIDEO WALL:
- Show a source: "Show the laptop", "Switch to AppleTV"
- Sources: Laptop (1), ClickShare (2), AppleTV (3), Conference (4)
- Complex layouts: "Split screen laptop and conference", "Picture-in-picture with AppleTV in corner"
- Check what's showing: "What's on the laptop?", "Describe all sources"

LIGHTING:
- Set level: "Lights to 50 percent"
- Adjust: "Dim the lights", "Brighten"
- Off/On: "Lights off", "Full brightness"

VOLUME:
- Levels: "Mute", "Volume low", "Medium", "High", "Max"

OTHER:
- Screen: "Screen on", "Screen off"
- Privacy glass: "Frost the glass", "Clear the glass"
- Status: "What's the room status?"

What would you like to do?`;
  }

  async roomStatus() {
    const s = await this.getState();

    const parts = [];

    // Screen and source
    if (s.screen) {
      parts.push(`Screen on, showing ${SOURCE_NAMES[s.source] || `source ${s.source}`}`);
    } else {
      parts.push('Screen off');
    }

    // Lights
    if (s.lights === 0) {
      parts.push('lights off');
    } else if (s.lights === 100) {
      parts.push('lights full');
    } else {
      parts.push(`lights at ${Math.round(s.lights)} percent`);
    }

    // Volume
    const volName = Object.entries(VOLUME_MAP)
      .find(([, v]) => Math.abs(v - s.volume) < 5)?.[0];
    if (volName === 'mute') {
      parts.push('muted');
    } else if (volName) {
      parts.push(`volume ${volName}`);
    } else {
      parts.push(`volume ${s.volume} dB`);
    }

    // Glass
    parts.push(s.glass ? 'glass frosted' : 'glass clear');

    return parts.join(', ') + '.';
  }

  async setSource(args) {
    let sourceId = args.source;

    // Handle string source names
    if (typeof sourceId === 'string') {
      sourceId = SOURCE_IDS[sourceId.toLowerCase()] || parseInt(sourceId);
    }

    if (sourceId < 1 || sourceId > 4) {
      return 'Invalid source.';
    }

    const current = await this.getState();
    if (current.source === sourceId) {
      return `Already on ${SOURCE_NAMES[sourceId]}.`;
    }

    // Build WindowCommand
    const cmd = `BV1:E:A1:1:W1S${sourceId}X0Y0W100H100A0`;
    await this.sendControl('videoWall', 'WindowCommand', cmd);
    this.cache.state.source = sourceId;

    return 'Done.';
  }

  async screenPower(args) {
    const on = args.on;
    const current = await this.getState();

    if (current.screen === on) {
      return on ? 'Already on.' : 'Already off.';
    }

    await this.sendControl('hdmiDisplay', 'hdmi.enabled.button', on ? 1 : 0);
    this.cache.state.screen = on;

    return 'Done.';
  }

  async privacyGlass(args) {
    const frosted = args.frosted;
    const current = await this.getState();

    if (current.glass === frosted) {
      return frosted ? 'Already frosted.' : 'Already clear.';
    }

    await this.sendControl('gpio', 'pin.8.digital.out', frosted ? 1 : 0);
    this.cache.state.glass = frosted;

    return 'Done.';
  }

  async setLights(args) {
    let level = args.level;
    const current = await this.getState();

    // Check if relative adjustment (string with +/- prefix)
    if (typeof level === 'string') {
      if (level.startsWith('+') || level.startsWith('-')) {
        const delta = parseInt(level);
        level = current.lights + delta;
      } else {
        level = parseInt(level);
      }
    } else if (typeof level === 'number' && (level < -100 || (level < 0 && level > -100))) {
      // Negative number = relative decrease (e.g., -20 means dim by 20)
      // But only if it's clearly a delta (small negative)
      if (level < 0) {
        level = current.lights + level;
      }
    }

    // Clamp to valid range
    level = Math.max(0, Math.min(100, level));

    await this.sendControl('lighting', 'ZoneDimLevel1', level);
    this.cache.state.lights = level;

    if (level === 0) return 'Lights off.';
    if (level === 100) return 'Full brightness.';
    return 'Done.';
  }

  async setVolume(args) {
    const level = args.level;
    const db = VOLUME_MAP[level];

    if (db === undefined) {
      return 'Invalid volume level.';
    }

    await this.sendControl('mixer', 'output.1.gain', db);
    this.cache.state.volume = db;

    if (level === 'mute') return 'Muted.';
    if (level === 'max') return 'Maximum volume.';
    return 'Done.';
  }

  async didoOutput(args) {
    const enabled = args.enabled;
    const current = await this.getState();

    if (current.dido === enabled) {
      return enabled ? 'Already enabled.' : 'Already disabled.';
    }

    await this.sendControl('hdmiDecoder', 'hdmi.out.1.select.hdmi.1', enabled ? 1 : 0);
    this.cache.state.dido = enabled;

    return 'Done.';
  }

  async listSources() {
    const current = await this.getState();
    const sources = current.connectedSources;

    if (!sources || sources.length === 0) {
      return 'No sources detected.';
    }

    const status = sources.map((s, i) => {
      const name = SOURCE_NAMES[i + 1] || `Source ${i + 1}`;
      return `${name} ${s.connected ? 'connected' : 'not connected'}`;
    });

    return `${sources.length} sources: ${status.join(', ')}.`;
  }

  async setLayout(args) {
    const windows = args.windows;

    if (!windows || !Array.isArray(windows) || windows.length === 0) {
      return 'No windows specified.';
    }

    if (windows.length > 4) {
      return 'Maximum 4 windows allowed.';
    }

    // Build WindowCommand string
    // Format: BV1:E:A1:1:W1S{src}X{x}Y{y}W{w}H{h}A{opacity}:W2S...
    const windowParts = windows.map((win, i) => {
      let sourceId = win.source;

      // Handle string source names
      if (typeof sourceId === 'string') {
        sourceId = SOURCE_IDS[sourceId.toLowerCase()] || parseInt(sourceId);
      }

      if (sourceId < 1 || sourceId > 4) {
        throw new Error(`Invalid source ${sourceId}`);
      }

      const x = Math.max(0, Math.min(100, win.x || 0));
      const y = Math.max(0, Math.min(100, win.y || 0));
      const w = Math.max(1, Math.min(100, win.width || 100));
      const h = Math.max(1, Math.min(100, win.height || 100));
      // Opacity: 0 = transparent, 100 = opaque
      // But in WindowCommand, A0 = opaque, A100 = transparent (inverted)
      const opacity = win.opacity !== undefined ? win.opacity : 100;
      const alpha = 100 - Math.max(0, Math.min(100, opacity));

      return `W${i + 1}S${sourceId}X${x}Y${y}W${w}H${h}A${alpha}`;
    });

    const cmd = `BV1:E:A1:${windows.length}:${windowParts.join(':')}`;

    await this.sendControl('videoWall', 'WindowCommand', cmd);

    // Update cache with primary source
    if (windows.length > 0) {
      let primarySource = windows[0].source;
      if (typeof primarySource === 'string') {
        primarySource = SOURCE_IDS[primarySource.toLowerCase()] || 1;
      }
      this.cache.state.source = primarySource;
    }

    return 'Done.';
  }

  async describeSources(args) {
    const model = getGeminiModel();
    if (!model) {
      return 'Vision not available. Set GEMINI_API_KEY.';
    }

    const current = await this.getState();
    const sources = current.connectedSources || [];

    if (sources.length === 0) {
      return 'No sources detected.';
    }

    // Determine which sources to analyze
    let toAnalyze = [];
    if (args.source) {
      const idx = args.source - 1;
      if (sources[idx] && sources[idx].connected && sources[idx].snapshotUrl) {
        toAnalyze = [{ index: idx, source: sources[idx] }];
      } else {
        return `${SOURCE_NAMES[args.source]} not connected or no snapshot.`;
      }
    } else {
      // Analyze all connected sources with snapshots
      sources.forEach((s, i) => {
        if (s.connected && s.snapshotUrl) {
          toAnalyze.push({ index: i, source: s });
        }
      });
    }

    if (toAnalyze.length === 0) {
      return 'No sources with snapshots available.';
    }

    // Analyze each source
    const descriptions = [];
    for (const item of toAnalyze) {
      try {
        const name = SOURCE_NAMES[item.index + 1] || `Source ${item.index + 1}`;

        // Use proxied stream URL (Tailscale accessible) and grab a frame
        const streamUrl = item.source.proxiedPreviewUrl;

        if (!streamUrl) {
          descriptions.push(`${name}: no stream URL`);
          continue;
        }

        // Grab single frame from MJPEG stream
        const response = await grabMjpegFrame(streamUrl);
        if (!response.ok) {
          descriptions.push(`${name}: snapshot unavailable`);
          continue;
        }

        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');

        // Analyze with Gemini
        const result = await model.generateContent([
          'Describe what is shown on this screen in 10 words or less. Focus on: presentation type, video call, desktop, video content, app name. Be concise.',
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64
            }
          }
        ]);

        const description = result.response.text().trim();
        descriptions.push(`${name}: ${description}`);

      } catch (error) {
        const name = SOURCE_NAMES[item.index + 1] || `Source ${item.index + 1}`;
        logger.error({ error: error.message, source: name }, 'Vision analysis failed');
        descriptions.push(`${name}: analysis failed`);
      }
    }

    return descriptions.join('. ') + '.';
  }

  /**
   * Get tool definitions for VAPI
   */
  getToolDefinitions() {
    return [
      {
        type: 'function',
        function: {
          name: 'room_status',
          description: 'Get current room status including screen, source, lights, volume, and glass. Use when user asks "What\'s the status?" or "Is everything on?"',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_source',
          description: 'Switch video wall source. Sources: 1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference. Use when user says "Show the laptop" or "Switch to AppleTV".',
          parameters: {
            type: 'object',
            properties: {
              source: {
                type: 'number',
                description: '1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference'
              }
            },
            required: ['source']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'screen_power',
          description: 'Turn screen on or off. Use when user says "Turn on the screen" or "Screen off".',
          parameters: {
            type: 'object',
            properties: {
              on: { type: 'boolean' }
            },
            required: ['on']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'privacy_glass',
          description: 'Set privacy glass frosted or clear. Use when user says "Frost the glass" or "Make it clear".',
          parameters: {
            type: 'object',
            properties: {
              frosted: { type: 'boolean' }
            },
            required: ['frosted']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_lights',
          description: 'Set lighting level. Use absolute (0-100) or relative (-20 to dim, +20 to brighten). Examples: "50" for 50%, "-20" to dim by 20%, "+30" to brighten. Use when user says "Lights to 50", "Dim the lights", "Brighten", "Lights off".',
          parameters: {
            type: 'object',
            properties: {
              level: { type: 'number', description: '0-100 for absolute, or negative to dim (e.g., -20)' }
            },
            required: ['level']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_volume',
          description: 'Set volume level. Levels: mute, low, medium, high, max. Use when user says "Volume up" or "Mute".',
          parameters: {
            type: 'object',
            properties: {
              level: {
                type: 'string',
                enum: ['mute', 'low', 'medium', 'high', 'max']
              }
            },
            required: ['level']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'dido_output',
          description: 'Enable or disable DIDO output routing. Use when user says "Enable output" or "Turn off DIDO".',
          parameters: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' }
            },
            required: ['enabled']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_sources',
          description: 'List available video sources and connection status. Use when user asks "What sources are available?"',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'set_layout',
          description: `Set video wall layout with multiple windows. Sources: 1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference. Use when user wants picture-in-picture, split screen, or overlay layouts. Example: "Show ClickShare with AppleTV in the corner" or "Split screen laptop and conference".`,
          parameters: {
            type: 'object',
            properties: {
              windows: {
                type: 'array',
                description: 'Array of windows to display',
                items: {
                  type: 'object',
                  properties: {
                    source: { type: 'number', description: '1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference' },
                    x: { type: 'number', description: 'X position 0-100%' },
                    y: { type: 'number', description: 'Y position 0-100%' },
                    width: { type: 'number', description: 'Width 0-100%' },
                    height: { type: 'number', description: 'Height 0-100%' },
                    opacity: { type: 'number', description: 'Opacity 0-100 (100=opaque, 0=transparent)' }
                  },
                  required: ['source']
                }
              }
            },
            required: ['windows']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'describe_sources',
          description: 'Analyze what each source is showing using AI vision. Use when user asks "What\'s on the laptop?", "Is there a presentation?", "What are the sources showing?"',
          parameters: {
            type: 'object',
            properties: {
              source: {
                type: 'number',
                description: 'Specific source to analyze (1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference). Omit to analyze all connected sources.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_help',
          description: 'Get detailed instructions on how to use the AV system. Use when user asks for help, is confused, or you are unsure what to do.',
          parameters: { type: 'object', properties: {} }
        }
      }
    ];
  }
}

/**
 * Create Express router for voice endpoint
 */
export function createVoiceRouter(config, authMiddleware) {
  const router = Router();

  const voice = new VoiceEndpoint(config);

  // Initialize in background with delay to let main server connect first
  // Keep retrying indefinitely with exponential backoff
  const initWithRetry = (attempt = 1) => {
    voice.init().then(() => {
      logger.info({ attempt }, 'Voice endpoint initialized successfully');
    }).catch(e => {
      const delay = Math.min(5000 * Math.pow(1.5, attempt - 1), 30000);
      logger.error({ error: e.message, attempt, nextRetryMs: delay }, 'Voice endpoint init failed, will retry');
      setTimeout(() => initWithRetry(attempt + 1), delay);
    });
  };

  // Start after 10 seconds to let Tailscale proxy be ready
  setTimeout(() => initWithRetry(1), 10000);

  // Health check
  router.get('/health', (req, res) => {
    res.json({
      status: voice.isConnected && voice.isIdentified ? 'healthy' : 'degraded',
      connected: voice.isConnected,
      identified: voice.isIdentified
    });
  });

  // Get tool definitions (for VAPI setup)
  router.get('/tools', authMiddleware, (req, res) => {
    res.json(voice.getToolDefinitions());
  });

  // VAPI webhook endpoint
  router.post('/webhook', authMiddleware, async (req, res) => {
    const { message } = req.body;

    // Log full incoming request for debugging
    logger.info({
      type: message?.type,
      callId: req.headers['x-call-id'],
      body: JSON.stringify(req.body).substring(0, 500)
    }, 'VAPI request received');

    // Handle non-tool-call events
    if (message?.type !== 'tool-calls') {
      return res.json({ status: 'ok' });
    }

    const results = [];
    // Support both VAPI formats: toolCallList (server URL) and toolCalls (function calling)
    const toolCalls = message.toolCallList || message.toolCalls || [];

    for (const call of toolCalls) {
      // Handle both direct format (toolCallList) and nested format (toolCalls)
      const toolName = call.name || call.function?.name;
      const toolId = call.id;
      const rawArgs = call.arguments || call.function?.arguments || {};
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

      try {
        const result = await voice.handleTool(toolName, args);

        results.push({
          toolCallId: toolId,
          result: result
        });

        logger.info({ tool: toolName, result }, 'Tool executed');

      } catch (error) {
        const errorMsg = error.message.includes('Timeout')
          ? 'System not responding.'
          : error.message.includes('Not connected')
          ? 'Connection lost.'
          : 'Command failed.';

        results.push({
          toolCallId: toolId,
          error: errorMsg
        });

        logger.error({ tool: toolName, error: error.message }, 'Tool error');
      }
    }

    res.json({ results });
  });

  return router;
}

export { VoiceEndpoint, SOURCE_NAMES, SOURCE_IDS, VOLUME_MAP };
