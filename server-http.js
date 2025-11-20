#!/usr/bin/env node
/**
 * BUControl MCP Server - HTTP Streaming Version
 * Production-ready with Pino logging, Prometheus metrics, session management
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { io } from 'socket.io-client';
import { SocksProxyAgent } from 'socks-proxy-agent';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } } : undefined,
  base: { service: 'bucontrol-mcp', version: '1.0.0' }
});

const CONFIG = {
  httpPort: parseInt(process.env.PORT || process.env.HTTP_PORT || '3100'),
  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',
  controllerId: process.env.CONTROLLER_ID || 'modular-controller-config',
  websocketHost: process.env.WEBSOCKET_HOST || '100.71.254.15',
  websocketPort: parseInt(process.env.WEBSOCKET_PORT || '3004'),
  enableDebug: process.env.ENABLE_DEBUG === 'true',
  reconnectionDelayBase: parseInt(process.env.RECONNECTION_DELAY_BASE || '1000'),
  reconnectionDelayMax: parseInt(process.env.RECONNECTION_DELAY_MAX || '30000'),
  reconnectionAttempts: parseInt(process.env.RECONNECTION_ATTEMPTS || '0'),
  connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '20000'),
  identifyTimeout: parseInt(process.env.IDENTIFY_TIMEOUT || '5000'),
  commandTimeout: parseInt(process.env.COMMAND_TIMEOUT || '10000'),
  discoveryTimeout: parseInt(process.env.DISCOVERY_TIMEOUT || '10000')
};

const SECURITY = {
  apiKeys: new Map(),
  requireApiKey: process.env.REQUIRE_API_KEY !== 'false',
  corsOrigins: process.env.CORS_ORIGINS || '*',
  rateLimitTiers: { free: { windowMs: 60000, max: 30 }, basic: { windowMs: 60000, max: 100 }, premium: { windowMs: 60000, max: 500 }, unlimited: { windowMs: 60000, max: 10000 } },
  defaultRateLimit: { windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'), max: parseInt(process.env.RATE_LIMIT_MAX || '100') }
};

(process.env.API_KEYS || '').split(',').filter(k => k.length > 0).forEach(entry => {
  const [key, tier] = entry.split(':');
  SECURITY.apiKeys.set(key.trim(), tier?.trim() || 'basic');
});

if (SECURITY.requireApiKey && SECURITY.apiKeys.size === 0) { logger.error('No API keys configured'); process.exit(1); }

const metrics = { startTime: Date.now(), requestCount: 0, errorCount: 0, websocketConnections: 0, websocketReconnections: 0, websocketErrors: 0, toolCalls: new Map(), toolErrors: new Map(), activeSessions: new Map(), totalSessions: 0, rateLimitHits: 0 };

class SessionManager {
  constructor() { this.sessions = new Map(); this.cleanupInterval = setInterval(() => this.cleanup(), 60000); }
  create(clientInfo = {}) { const id = uuidv4(); const s = { id, createdAt: Date.now(), lastActivity: Date.now(), clientInfo, requestCount: 0, transport: null }; this.sessions.set(id, s); metrics.activeSessions.set(id, s); metrics.totalSessions++; logger.info({ sessionId: id }, 'Session created'); return s; }
  get(id) { return this.sessions.get(id); }
  update(id, data = {}) { const s = this.sessions.get(id); if (s) { Object.assign(s, data, { lastActivity: Date.now() }); s.requestCount++; } return s; }
  destroy(id) { const s = this.sessions.get(id); if (s) { this.sessions.delete(id); metrics.activeSessions.delete(id); logger.info({ sessionId: id }, 'Session destroyed'); } }
  cleanup() { const now = Date.now(); for (const [id, s] of this.sessions) if (now - s.lastActivity > 1800000) this.destroy(id); }
  close() { clearInterval(this.cleanupInterval); this.sessions.clear(); metrics.activeSessions.clear(); }
}
const sessionManager = new SessionManager();

let socket = null, isConnected = false, isIdentified = false, reconnectAttempt = 0;
const components = { videoWall: null, hdmiDisplay: null, gpio: null, hdmiDecoder: null, lighting: null, mixer: null };
const controlState = { hardwareState: null, connectedSources: null, screenPower: null, privacyGlass: null, didoOutput: null, lightingLevel: null, volumeLevel: null };
const discoveredComponents = { list: {}, watched: {} };

function calculateBackoff(attempt) { return Math.min(CONFIG.reconnectionDelayBase * Math.pow(2, attempt), CONFIG.reconnectionDelayMax) * (1 + Math.random() * 0.25); }

// WebSocket connection with retry
async function initWebSocket() {
  const url = `http://${CONFIG.websocketHost}:${CONFIG.websocketPort}`;
  return new Promise((resolve, reject) => {
    logger.info({ url }, 'Connecting to WebSocket bridge');

    // Build socket.io options
    const socketOptions = {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      pingInterval: 25000,
      pingTimeout: 60000,
      timeout: CONFIG.connectionTimeout
    };

    // Use SOCKS5 proxy when Tailscale is configured (for Render deployment)
    if (process.env.TAILSCALE_AUTHKEY) {
      const proxyUrl = process.env.TAILSCALE_SOCKS_PROXY || 'socks5://127.0.0.1:1055';
      logger.info({ proxyUrl }, 'Using Tailscale SOCKS5 proxy for WebSocket connection');
      const agent = new SocksProxyAgent(proxyUrl);
      socketOptions.agent = agent;
    }

    socket = io(url, socketOptions);
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), CONFIG.connectionTimeout);
    socket.on('connect', async () => {
      clearTimeout(timeout); isConnected = true; reconnectAttempt = 0; metrics.websocketConnections++;
      logger.info('Connected to WebSocket bridge');
      try { await identifyClient(); const d = await tryDiscoverComponents(); if (!d.success || d.componentCount === 0) { await new Promise(r => { socket.once('digitaltwin:ready', r); setTimeout(r, 30000); }); await tryDiscoverComponents(); } resolve(); } catch (e) { reject(e); }
    });
    socket.on('disconnect', () => { isConnected = false; isIdentified = false; logger.warn('Disconnected from WebSocket'); socket.removeAllListeners('component:state'); socket.removeAllListeners('control:update'); });
    socket.on('connect_error', (e) => { clearTimeout(timeout); metrics.websocketErrors++; reject(e); });
    socket.on('control:update', (data) => {
      const map = { HardwareState: 'hardwareState', 'hdmi.enabled.button': 'screenPower', 'pin.8.digital.out': 'privacyGlass', 'hdmi.out.1.select.hdmi.1': 'didoOutput', ZoneDimLevel1: 'lightingLevel', 'output.1.gain': 'volumeLevel' };
      if (data.controlId === 'ConnectedSources') { try { controlState.connectedSources = JSON.parse(data.control.string || data.control.value).sources; } catch(e) {} }
      else if (map[data.controlId]) controlState[map[data.controlId]] = data.control.value;
    });
  });
}

function identifyClient() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Identification timeout')), CONFIG.identifyTimeout);
    socket.once('client:identify:success', (data) => { clearTimeout(timeout); isIdentified = true; logger.info({ clientId: data.clientId }, 'Client identified'); resolve(data); });
    socket.emit('client:identify', { platform: 'mcp-http', device: 'render', osVersion: process.platform, appVersion: '2.0.0', buildNumber: '1', deviceName: 'BUControl MCP HTTP Server' });
  });
}

function tryDiscoverComponents() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ success: false, componentCount: 0 }), CONFIG.discoveryTimeout);
    socket.once('controller:state', (data) => {
      clearTimeout(timeout);
      if (!data.components) return resolve({ success: false, componentCount: 0 });
      Object.entries(data.components).forEach(([id, comp]) => { discoveredComponents.list[comp.name] = { id, name: comp.name, controls: comp.controls || {} }; });
      const entries = Object.entries(data.components);
      [['videoWall', ['BUControl', 'Video Wall']], ['hdmiDisplay', ['Generic_HDMI_Display']], ['gpio', ['GPIO_Out_Core-Maktabi']], ['hdmiDecoder', ['HDMI_I/ODecoder']], ['lighting', ['LutronLEAPZone']], ['mixer', ['Mixer_8x8_2']]].forEach(([key, patterns]) => {
        const found = entries.find(([, c]) => patterns.some(p => c.name.includes(p)));
        if (found) { components[key] = found[0]; logger.info({ component: key, id: found[0] }, 'Component found'); }
      });
      Object.values(components).filter(Boolean).forEach(id => socket.emit('component:watch', { controllerId: CONFIG.controllerId, componentId: id }));
      socket.on('component:state', (d) => {
        const c = d.component.controls; if (!c) return;
        if (c.HardwareState) controlState.hardwareState = c.HardwareState.value;
        if (c.ConnectedSources) try { controlState.connectedSources = JSON.parse(c.ConnectedSources.string || c.ConnectedSources.value).sources; } catch(e) {}
        if (c['hdmi.enabled.button']) controlState.screenPower = c['hdmi.enabled.button'].value;
        if (c['pin.8.digital.out']) controlState.privacyGlass = c['pin.8.digital.out'].value;
        if (c['hdmi.out.1.select.hdmi.1']) controlState.didoOutput = c['hdmi.out.1.select.hdmi.1'].value;
        if (c.ZoneDimLevel1) controlState.lightingLevel = c.ZoneDimLevel1.value;
        if (c['output.1.gain']) controlState.volumeLevel = c['output.1.gain'].value;
      });
      resolve({ success: true, componentCount: entries.length });
    });
    socket.emit('controller:subscribe', { controllerId: CONFIG.controllerId });
  });
}

function sendControl(componentId, controlId, value) {
  return new Promise((resolve, reject) => {
    if (!isConnected || !isIdentified) return reject(new Error('Not connected'));
    if (!componentId) return reject(new Error('Component not found'));
    const transactionId = `mcp-${Date.now()}-${uuidv4().slice(0,8)}`;
    const timeout = setTimeout(() => reject(new Error('Command timeout')), CONFIG.commandTimeout);
    const success = (d) => { if (d.transactionId === transactionId) { clearTimeout(timeout); socket.off('control:set:success', success); socket.off('control:set:error', error); resolve({ success: true, transactionId }); } };
    const error = (d) => { if (d.transactionId === transactionId) { clearTimeout(timeout); socket.off('control:set:success', success); socket.off('control:set:error', error); reject(new Error(d.message || 'Command failed')); } };
    socket.on('control:set:success', success); socket.on('control:set:error', error);
    socket.emit('control:set', { controllerId: CONFIG.controllerId, componentId, controlId, value, transactionId });
  });
}

function findComponent(name) { const match = Object.keys(discoveredComponents.list).find(n => n.toLowerCase().includes(name.toLowerCase())); return match ? discoveredComponents.list[match] : null; }

// MCP Server
const server = new Server({ name: 'bucontrol-http', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'send_videowall_command', description: 'Send WindowCommand to video wall. Format: BV1:E:A1:1:W1S1X0Y0W100H100A0', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'get_videowall_status', description: 'Get current video wall hardware state', inputSchema: { type: 'object', properties: {} } },
    { name: 'list_video_sources', description: 'List video sources and connection status', inputSchema: { type: 'object', properties: {} } },
    { name: 'set_screen_power', description: 'Turn screen on/off', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
    { name: 'get_screen_power', description: 'Get screen power state', inputSchema: { type: 'object', properties: {} } },
    { name: 'set_privacy_glass', description: 'Control privacy glass', inputSchema: { type: 'object', properties: { frosted: { type: 'boolean' } }, required: ['frosted'] } },
    { name: 'get_privacy_glass', description: 'Get privacy glass state', inputSchema: { type: 'object', properties: {} } },
    { name: 'set_dido_output', description: 'Enable/disable DIDO output', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
    { name: 'get_dido_output', description: 'Get DIDO output state', inputSchema: { type: 'object', properties: {} } },
    { name: 'set_lighting_level', description: 'Set lighting level 0-100', inputSchema: { type: 'object', properties: { level: { type: 'number' } }, required: ['level'] } },
    { name: 'get_lighting_level', description: 'Get lighting level', inputSchema: { type: 'object', properties: {} } },
    { name: 'set_volume', description: 'Set volume -100 to +10 dB', inputSchema: { type: 'object', properties: { level: { type: 'number' } }, required: ['level'] } },
    { name: 'get_volume', description: 'Get volume level', inputSchema: { type: 'object', properties: {} } },
    { name: 'list_components', description: 'List all components', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
    { name: 'get_component_details', description: 'Get component details', inputSchema: { type: 'object', properties: { componentName: { type: 'string' } }, required: ['componentName'] } },
    { name: 'set_control_generic', description: 'Set any control value', inputSchema: { type: 'object', properties: { componentName: { type: 'string' }, controlId: { type: 'string' }, value: {} }, required: ['componentName', 'controlId', 'value'] } },
    { name: 'get_connection_status', description: 'Get connection status', inputSchema: { type: 'object', properties: {} } },
    { name: 'reconnect', description: 'Force reconnection', inputSchema: { type: 'object', properties: {} } }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  metrics.toolCalls.set(name, (metrics.toolCalls.get(name) || 0) + 1);
  try {
    switch (name) {
      case 'send_videowall_command': return { content: [{ type: 'text', text: JSON.stringify(await sendControl(components.videoWall, 'WindowCommand', args.command)) }] };
      case 'get_videowall_status': return { content: [{ type: 'text', text: JSON.stringify({ status: controlState.hardwareState ? 'success' : 'unknown', hardwareState: controlState.hardwareState }) }] };
      case 'list_video_sources': return { content: [{ type: 'text', text: JSON.stringify({ status: controlState.connectedSources ? 'success' : 'unknown', sources: controlState.connectedSources }) }] };
      case 'set_screen_power': return { content: [{ type: 'text', text: JSON.stringify(await sendControl(components.hdmiDisplay, 'hdmi.enabled.button', args.enabled ? 1 : 0)) }] };
      case 'get_screen_power': return { content: [{ type: 'text', text: JSON.stringify({ enabled: controlState.screenPower === 1 }) }] };
      case 'set_privacy_glass': return { content: [{ type: 'text', text: JSON.stringify(await sendControl(components.gpio, 'pin.8.digital.out', args.frosted ? 1 : 0)) }] };
      case 'get_privacy_glass': return { content: [{ type: 'text', text: JSON.stringify({ frosted: controlState.privacyGlass === 1 }) }] };
      case 'set_dido_output': return { content: [{ type: 'text', text: JSON.stringify(await sendControl(components.hdmiDecoder, 'hdmi.out.1.select.hdmi.1', args.enabled ? 1 : 0)) }] };
      case 'get_dido_output': return { content: [{ type: 'text', text: JSON.stringify({ enabled: controlState.didoOutput === 1 }) }] };
      case 'set_lighting_level': return { content: [{ type: 'text', text: JSON.stringify(await sendControl(components.lighting, 'ZoneDimLevel1', Math.max(0, Math.min(100, args.level)))) }] };
      case 'get_lighting_level': return { content: [{ type: 'text', text: JSON.stringify({ level: controlState.lightingLevel }) }] };
      case 'set_volume': return { content: [{ type: 'text', text: JSON.stringify(await sendControl(components.mixer, 'output.1.gain', Math.max(-100, Math.min(10, args.level)))) }] };
      case 'get_volume': return { content: [{ type: 'text', text: JSON.stringify({ level: controlState.volumeLevel, unit: 'dB' }) }] };
      case 'list_components': { let list = Object.values(discoveredComponents.list); if (args.filter) list = list.filter(c => c.name.toLowerCase().includes(args.filter.toLowerCase())); return { content: [{ type: 'text', text: JSON.stringify({ count: list.length, components: list.map(c => ({ id: c.id, name: c.name, controlCount: Object.keys(c.controls).length })) }) }] }; }
      case 'get_component_details': { const c = findComponent(args.componentName); if (!c) throw new Error('Component not found'); return { content: [{ type: 'text', text: JSON.stringify({ id: c.id, name: c.name, controls: c.controls }) }] }; }
      case 'set_control_generic': { const c = findComponent(args.componentName); if (!c) throw new Error('Component not found'); return { content: [{ type: 'text', text: JSON.stringify(await sendControl(c.id, args.controlId, args.value)) }] }; }
      case 'get_connection_status': return { content: [{ type: 'text', text: JSON.stringify({ connected: isConnected, identified: isIdentified, components: Object.keys(discoveredComponents.list).length }) }] };
      case 'reconnect': { if (socket) { socket.disconnect(); isConnected = false; isIdentified = false; await initWebSocket(); return { content: [{ type: 'text', text: JSON.stringify({ success: true, components: Object.keys(discoveredComponents.list).length }) }] }; } throw new Error('No connection'); }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) { metrics.toolErrors.set(name, (metrics.toolErrors.get(name) || 0) + 1); metrics.errorCount++; return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true }; }
});

// Express App
const app = express();
app.use(cors({ origin: SECURITY.corsOrigins === '*' ? true : SECURITY.corsOrigins.split(','), credentials: true }));
app.use(express.json());
app.use((req, res, next) => { metrics.requestCount++; next(); });

const limiter = rateLimit({ windowMs: SECURITY.defaultRateLimit.windowMs, max: SECURITY.defaultRateLimit.max, message: { error: 'Rate limit exceeded' } });
app.use('/sse', limiter); app.use('/message', limiter);

function authMiddleware(req, res, next) {
  if (!SECURITY.requireApiKey) return next();
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!key) return res.status(401).json({ error: 'API key required' });
  if (!SECURITY.apiKeys.has(key)) { metrics.errorCount++; return res.status(403).json({ error: 'Invalid API key' }); }
  req.apiKeyTier = SECURITY.apiKeys.get(key);
  next();
}

app.get('/health', (req, res) => res.json({ status: isConnected && isIdentified ? 'healthy' : 'degraded', websocket: { connected: isConnected, identified: isIdentified }, components: Object.keys(discoveredComponents.list).length, uptime: Math.floor((Date.now() - metrics.startTime) / 1000) }));
app.get('/ready', (req, res) => isConnected && isIdentified ? res.json({ ready: true }) : res.status(503).json({ ready: false }));
app.get('/live', (req, res) => res.json({ alive: true }));

app.get('/metrics', (req, res) => {
  const toolCallsStr = Array.from(metrics.toolCalls.entries()).map(([k, v]) => `mcp_tool_calls{tool="${k}"} ${v}`).join('\n');
  res.type('text/plain').send(`# HELP mcp_requests_total Total requests\nmcp_requests_total ${metrics.requestCount}\n# HELP mcp_errors_total Total errors\nmcp_errors_total ${metrics.errorCount}\n# HELP mcp_websocket_connected WebSocket status\nmcp_websocket_connected ${isConnected ? 1 : 0}\n# HELP mcp_components_discovered Discovered components\nmcp_components_discovered ${Object.keys(discoveredComponents.list).length}\n# HELP mcp_sessions_active Active sessions\nmcp_sessions_active ${sessionManager.sessions.size}\n# HELP mcp_uptime_seconds Uptime\nmcp_uptime_seconds ${Math.floor((Date.now() - metrics.startTime) / 1000)}\n${toolCallsStr}`);
});

app.get('/sse', authMiddleware, async (req, res) => {
  logger.info({ ip: req.ip }, 'SSE client connected');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const transport = new SSEServerTransport('/message', res);
  await server.connect(transport);
});

app.post('/message', authMiddleware, express.json(), async (req, res) => {
  logger.debug({ body: req.body }, 'Message received');
  res.json({ received: true });
});

// Main
async function main() {
  logger.info({ config: { port: CONFIG.httpPort, wsHost: CONFIG.websocketHost, wsPort: CONFIG.websocketPort } }, 'Starting BUControl MCP HTTP Server');

  const httpServer = app.listen(CONFIG.httpPort, CONFIG.bindAddress, () => {
    logger.info({ address: `${CONFIG.bindAddress}:${CONFIG.httpPort}` }, 'HTTP server listening');
  });

  // Connect to WebSocket in background
  initWebSocket().then(() => logger.info('WebSocket initialized')).catch(e => logger.error({ error: e.message }, 'WebSocket init failed'));

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    sessionManager.close();
    if (socket) socket.disconnect();
    httpServer.close(() => { logger.info('Server closed'); process.exit(0); });
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => { logger.fatal({ error: e.message }, 'Uncaught exception'); if (process.env.NODE_ENV !== 'production') process.exit(1); });
  process.on('unhandledRejection', (r) => logger.error({ reason: r }, 'Unhandled rejection'));
}

main().catch(e => { logger.fatal({ error: e.message }, 'Failed to start'); process.exit(1); });
