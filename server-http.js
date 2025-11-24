#!/usr/bin/env node
/**
 * BUControl MCP Server - HTTP Streaming Version
 * Production-ready with Pino logging, Prometheus metrics, session management
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { io } from 'socket.io-client';
import { SocksProxyAgent } from 'socks-proxy-agent';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { createVoiceRouter } from './voice-endpoint.js';

// Authorization codes storage for PKCE flow (code -> { client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires })
const authorizationCodes = new Map();

// Microsoft Graph tokens storage (per room/session)
// In production, consider Redis or database for persistence
const msGraphTokens = {
  current: null, // { accessToken, refreshToken, expiresAt, user }
  history: []
};

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
  oauthClients: new Map(),
  requireApiKey: process.env.REQUIRE_API_KEY !== 'false',
  corsOrigins: process.env.CORS_ORIGINS || '*',
  rateLimitTiers: { free: { windowMs: 60000, max: 30 }, basic: { windowMs: 60000, max: 100 }, premium: { windowMs: 60000, max: 500 }, unlimited: { windowMs: 60000, max: 10000 } },
  defaultRateLimit: { windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'), max: parseInt(process.env.RATE_LIMIT_MAX || '100') },
  oauth: {
    enabled: process.env.OAUTH_ENABLED === 'true',
    jwksUri: process.env.OAUTH_JWKS_URI || '',
    issuer: process.env.OAUTH_ISSUER || '',
    audience: process.env.OAUTH_AUDIENCE || '',
    secret: process.env.OAUTH_SECRET || '',
    algorithms: (process.env.OAUTH_ALGORITHMS || 'RS256').split(','),
    tokenExpiry: process.env.OAUTH_TOKEN_EXPIRY || '24h'
  }
};

// Parse OAuth clients (format: clientId:clientSecret:tier)
(process.env.OAUTH_CLIENTS || '').split(',').filter(c => c.length > 0).forEach(entry => {
  const [clientId, clientSecret, tier] = entry.split(':');
  if (clientId && clientSecret) {
    SECURITY.oauthClients.set(clientId.trim(), { secret: clientSecret.trim(), tier: tier?.trim() || 'basic' });
  }
});

// Initialize JWKS client for OAuth token validation
let jwksClient = null;
if (SECURITY.oauth.enabled && SECURITY.oauth.jwksUri) {
  jwksClient = jwksRsa({
    jwksUri: SECURITY.oauth.jwksUri,
    cache: true,
    cacheMaxAge: 600000,
    rateLimit: true,
    jwksRequestsPerMinute: 10
  });
  logger.info({ jwksUri: SECURITY.oauth.jwksUri }, 'OAuth JWKS client initialized');
}

// Helper to get signing key from JWKS
function getSigningKey(header, callback) {
  if (!jwksClient) {
    return callback(new Error('JWKS client not configured'));
  }
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

// Validate OAuth Bearer token
async function validateOAuthToken(token) {
  return new Promise((resolve, reject) => {
    const options = {
      algorithms: SECURITY.oauth.algorithms
    };

    if (SECURITY.oauth.issuer) options.issuer = SECURITY.oauth.issuer;
    if (SECURITY.oauth.audience) options.audience = SECURITY.oauth.audience;

    // Use JWKS or secret for verification
    if (jwksClient) {
      jwt.verify(token, getSigningKey, options, (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      });
    } else if (SECURITY.oauth.secret) {
      jwt.verify(token, SECURITY.oauth.secret, options, (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      });
    } else {
      reject(new Error('No OAuth verification method configured'));
    }
  });
}

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
    socket.on('disconnect', (reason) => {
      isConnected = false; isIdentified = false;
      logger.warn({ reason }, 'Disconnected from WebSocket');
      socket.removeAllListeners('component:state'); socket.removeAllListeners('control:update');
    });
    socket.on('connect_error', (e) => { clearTimeout(timeout); metrics.websocketErrors++; reject(e); });

    // Handle auto-reconnection - re-identify and rediscover components
    socket.on('reconnect', async (attemptNumber) => {
      logger.info({ attemptNumber }, 'Reconnected to WebSocket');
      isConnected = true;
      metrics.websocketReconnections++;
      try {
        await identifyClient();
        await tryDiscoverComponents();
        logger.info('Re-identified after reconnection');
      } catch (e) {
        logger.error({ error: e.message }, 'Failed to re-identify after reconnection');
      }
    });

    // Client-side heartbeat and status poll to keep connection alive
    setInterval(() => {
      if (isConnected && socket) {
        socket.emit('ping', { timestamp: Date.now() });
        if (isIdentified) {
          socket.emit('controller:subscribe', { controllerId: CONFIG.controllerId });
        }
        logger.debug('Heartbeat ping sent');
      }
    }, 25000); // Every 25 seconds

    socket.on('reconnect_attempt', (attemptNumber) => {
      logger.debug({ attemptNumber }, 'Attempting to reconnect');
    });

    socket.on('reconnect_error', (e) => {
      logger.warn({ error: e.message }, 'Reconnection error');
    });
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
    { name: 'reconnect', description: 'Force reconnection', inputSchema: { type: 'object', properties: {} } },
    // Microsoft Graph tools
    { name: 'graph_get_user', description: 'Get signed-in Microsoft user info', inputSchema: { type: 'object', properties: {} } },
    { name: 'graph_list_recent_files', description: 'List user\'s recently accessed files from OneDrive/SharePoint', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max files to return (default 10)' } } } },
    { name: 'graph_list_presentations', description: 'List user\'s PowerPoint presentations', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max files to return (default 10)' } } } },
    { name: 'graph_get_file_info', description: 'Get details about a specific file by ID', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } },
    { name: 'graph_get_file_content_url', description: 'Get download/embed URL for a file', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } }
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
      // Microsoft Graph tools
      case 'graph_get_user': {
        const user = await callGraphAPI('/me');
        return { content: [{ type: 'text', text: JSON.stringify({ displayName: user.displayName, email: user.mail || user.userPrincipalName, jobTitle: user.jobTitle, department: user.department }) }] };
      }
      case 'graph_list_recent_files': {
        const limit = args.limit || 10;
        const result = await callGraphAPI(`/me/drive/recent?$top=${limit}`);
        const files = result.value.map(f => ({ id: f.id, name: f.name, webUrl: f.webUrl, lastModified: f.lastModifiedDateTime, size: f.size, mimeType: f.file?.mimeType }));
        return { content: [{ type: 'text', text: JSON.stringify({ count: files.length, files }) }] };
      }
      case 'graph_list_presentations': {
        const limit = args.limit || 10;
        // Search for PowerPoint files
        const result = await callGraphAPI(`/me/drive/root/search(q='.pptx')?$top=${limit}&$orderby=lastModifiedDateTime desc`);
        const files = result.value.map(f => ({ id: f.id, name: f.name, webUrl: f.webUrl, lastModified: f.lastModifiedDateTime, size: f.size }));
        return { content: [{ type: 'text', text: JSON.stringify({ count: files.length, presentations: files }) }] };
      }
      case 'graph_get_file_info': {
        const file = await callGraphAPI(`/me/drive/items/${args.fileId}`);
        return { content: [{ type: 'text', text: JSON.stringify({ id: file.id, name: file.name, webUrl: file.webUrl, size: file.size, lastModified: file.lastModifiedDateTime, createdBy: file.createdBy?.user?.displayName, mimeType: file.file?.mimeType }) }] };
      }
      case 'graph_get_file_content_url': {
        const file = await callGraphAPI(`/me/drive/items/${args.fileId}`);
        // Get a sharing link for embedding
        const shareResult = await callGraphAPI(`/me/drive/items/${args.fileId}/createLink`, {
          method: 'POST',
          body: JSON.stringify({ type: 'embed', scope: 'organization' })
        });
        return { content: [{ type: 'text', text: JSON.stringify({ id: file.id, name: file.name, downloadUrl: file['@microsoft.graph.downloadUrl'], embedUrl: shareResult.link?.webUrl, webUrl: file.webUrl }) }] };
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) { metrics.toolErrors.set(name, (metrics.toolErrors.get(name) || 0) + 1); metrics.errorCount++; return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true }; }
});

// Express App
const app = express();
app.use(cors({ origin: SECURITY.corsOrigins === '*' ? true : SECURITY.corsOrigins.split(','), credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set default Accept headers for MCP endpoints if not provided
app.use('/mcp', (req, res, next) => {
  if (!req.headers.accept || req.headers.accept === '*/*') {
    req.headers.accept = 'application/json, text/event-stream';
  }
  next();
});

app.use((req, res, next) => { metrics.requestCount++; next(); });

const limiter = rateLimit({ windowMs: SECURITY.defaultRateLimit.windowMs, max: SECURITY.defaultRateLimit.max, message: { error: 'Rate limit exceeded' } });
app.use('/mcp', limiter);

async function authMiddleware(req, res, next) {
  if (!SECURITY.requireApiKey && !SECURITY.oauth.enabled) return next();

  // Check for OAuth Bearer token first
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (!SECURITY.oauth.enabled) {
      return res.status(401).json({ error: 'OAuth not enabled' });
    }

    const token = authHeader.substring(7);
    try {
      const decoded = await validateOAuthToken(token);
      req.auth = {
        type: 'oauth',
        user: decoded,
        tier: decoded.tier || decoded.scope?.includes('premium') ? 'premium' : 'basic'
      };
      logger.debug({ sub: decoded.sub }, 'OAuth token validated');
      return next();
    } catch (err) {
      metrics.errorCount++;
      logger.warn({ error: err.message }, 'OAuth token validation failed');
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // Fall back to API key authentication
  if (!SECURITY.requireApiKey) return next();

  const key = req.headers['x-api-key'] || req.headers['x-vapi-secret'] || req.query.apiKey;
  if (!key) {
    return res.status(401).json({
      error: 'Authentication required',
      methods: SECURITY.oauth.enabled
        ? ['Authorization: Bearer <token>', 'x-api-key: <key>']
        : ['x-api-key: <key>']
    });
  }

  if (!SECURITY.apiKeys.has(key)) {
    metrics.errorCount++;
    return res.status(403).json({ error: 'Invalid API key' });
  }

  req.auth = {
    type: 'apikey',
    tier: SECURITY.apiKeys.get(key)
  };
  req.apiKeyTier = req.auth.tier;
  next();
}

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  // Use X-Forwarded-Proto for correct protocol behind reverse proxy
  const protocol = req.get('X-Forwarded-Proto') || req.protocol;
  const baseUrl = `${protocol}://${req.get('host')}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    grant_types_supported: ['authorization_code', 'client_credentials'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['claudeai']
  });
});

// OAuth authorization endpoint for Authorization Code flow with PKCE
app.get('/authorize', (req, res) => {
  if (!SECURITY.oauth.enabled) {
    return res.status(400).json({ error: 'oauth_disabled', error_description: 'OAuth is not enabled' });
  }

  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query;

  // Validate required parameters
  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only code response type is supported' });
  }

  if (!client_id) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
  }

  if (!redirect_uri) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
  }

  if (!code_challenge) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge is required for PKCE' });
  }

  if (code_challenge_method && code_challenge_method !== 'S256') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' });
  }

  // For PKCE flow, we accept any client_id (security comes from code_verifier)
  // This allows Claude and other public clients to authenticate

  // Generate authorization code
  const code = randomUUID();

  // Store code with PKCE challenge (expires in 10 minutes)
  authorizationCodes.set(code, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method: code_challenge_method || 'S256',
    scope: scope || '',
    expires: Date.now() + 600000
  });

  logger.info({ client_id, scope }, 'Authorization code generated');

  // Redirect back with code and state
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  res.redirect(redirectUrl.toString());
});

// OAuth token endpoint for client credentials and authorization code flows
app.post('/oauth/token', (req, res) => {
  if (!SECURITY.oauth.enabled) {
    return res.status(400).json({ error: 'oauth_disabled', error_description: 'OAuth is not enabled' });
  }

  const { grant_type, client_id, client_secret, code, code_verifier, redirect_uri } = req.body;

  // Handle Authorization Code grant (PKCE)
  if (grant_type === 'authorization_code') {
    if (!code) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
    }

    if (!code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier is required for PKCE' });
    }

    // Retrieve and validate authorization code
    const authCode = authorizationCodes.get(code);
    if (!authCode) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
    }

    // Delete code immediately (one-time use)
    authorizationCodes.delete(code);

    // Check expiration
    if (Date.now() > authCode.expires) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
    }

    // Validate client_id matches
    if (client_id && client_id !== authCode.client_id) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    }

    // Validate redirect_uri matches
    if (redirect_uri && redirect_uri !== authCode.redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // Verify PKCE code_verifier
    const expectedChallenge = createHash('sha256')
      .update(code_verifier)
      .digest('base64url');

    if (expectedChallenge !== authCode.code_challenge) {
      logger.warn({ client_id: authCode.client_id }, 'PKCE verification failed');
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    // Get client tier (default to basic for public PKCE clients)
    const client = SECURITY.oauthClients.get(authCode.client_id);
    const tier = client?.tier || 'basic';

    // Generate access token
    const token = jwt.sign(
      { sub: authCode.client_id, tier, type: 'access_token', scope: authCode.scope },
      SECURITY.oauth.secret,
      { algorithm: 'HS256', expiresIn: SECURITY.oauth.tokenExpiry }
    );

    logger.info({ client_id: authCode.client_id, tier }, 'OAuth token issued via authorization_code');

    return res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 86400
    });
  }

  // Handle Client Credentials grant
  if (grant_type === 'client_credentials') {
    if (!client_id || !client_secret) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id and client_secret are required' });
    }

    const client = SECURITY.oauthClients.get(client_id);
    if (!client || client.secret !== client_secret) {
      metrics.errorCount++;
      logger.warn({ client_id }, 'Invalid OAuth client credentials');
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }

    // Generate access token
    const token = jwt.sign(
      { sub: client_id, tier: client.tier, type: 'access_token' },
      SECURITY.oauth.secret,
      { algorithm: 'HS256', expiresIn: SECURITY.oauth.tokenExpiry }
    );

    logger.info({ client_id, tier: client.tier }, 'OAuth token issued via client_credentials');

    return res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 86400
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Supported grant types: authorization_code, client_credentials' });
});

app.get('/health', (req, res) => res.json({ status: isConnected && isIdentified ? 'healthy' : 'degraded', websocket: { connected: isConnected, identified: isIdentified }, components: Object.keys(discoveredComponents.list).length, uptime: Math.floor((Date.now() - metrics.startTime) / 1000) }));
app.get('/ready', (req, res) => isConnected && isIdentified ? res.json({ ready: true }) : res.status(503).json({ ready: false }));
app.get('/live', (req, res) => res.json({ alive: true }));

app.get('/metrics', (req, res) => {
  const toolCallsStr = Array.from(metrics.toolCalls.entries()).map(([k, v]) => `mcp_tool_calls{tool="${k}"} ${v}`).join('\n');
  res.type('text/plain').send(`# HELP mcp_requests_total Total requests\nmcp_requests_total ${metrics.requestCount}\n# HELP mcp_errors_total Total errors\nmcp_errors_total ${metrics.errorCount}\n# HELP mcp_websocket_connected WebSocket status\nmcp_websocket_connected ${isConnected ? 1 : 0}\n# HELP mcp_components_discovered Discovered components\nmcp_components_discovered ${Object.keys(discoveredComponents.list).length}\n# HELP mcp_sessions_active Active sessions\nmcp_sessions_active ${sessionManager.sessions.size}\n# HELP mcp_uptime_seconds Uptime\nmcp_uptime_seconds ${Math.floor((Date.now() - metrics.startTime) / 1000)}\n${toolCallsStr}`);
});

// Voice webhook router for VAPI integration
const voiceRouter = createVoiceRouter(CONFIG, authMiddleware);
app.use('/voice', voiceRouter);

// Microsoft Graph token endpoint - receives tokens from orb UI
// No auth required - this is called from kiosk displays
app.post('/auth/microsoft', (req, res) => {
  const { accessToken, refreshToken, expiresIn, user } = req.body;

  if (!accessToken) {
    return res.status(400).json({ error: 'accessToken is required' });
  }

  // Store the token
  msGraphTokens.current = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (expiresIn || 3600) * 1000,
    user,
    receivedAt: Date.now()
  };

  // Keep history for audit
  msGraphTokens.history.push({
    user: user?.displayName || user?.userPrincipalName || 'Unknown',
    timestamp: Date.now()
  });

  // Limit history to last 50 entries
  if (msGraphTokens.history.length > 50) {
    msGraphTokens.history = msGraphTokens.history.slice(-50);
  }

  logger.info({ user: user?.displayName }, 'Microsoft Graph token received');

  res.json({ success: true, user: user?.displayName });
});

// Get current Microsoft auth status
app.get('/auth/microsoft', authMiddleware, (req, res) => {
  if (!msGraphTokens.current) {
    return res.json({ authenticated: false });
  }

  const isExpired = Date.now() > msGraphTokens.current.expiresAt;
  res.json({
    authenticated: !isExpired,
    user: msGraphTokens.current.user?.displayName,
    expiresAt: msGraphTokens.current.expiresAt,
    isExpired
  });
});

// Azure AD Device Code Flow proxy endpoints (to bypass CORS restrictions)
// These proxy the browser's requests to Azure AD since the browser can't call Azure AD directly

// Proxy for device code request
app.post('/auth/microsoft/devicecode', async (req, res) => {
  const { client_id, scope, tenant = 'organizations' } = req.body;

  if (!client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }

  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id,
          scope: scope || 'User.Read Files.Read offline_access'
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      logger.warn({ error: data.error, description: data.error_description }, 'Azure AD device code error');
      return res.status(response.status).json(data);
    }

    logger.info({ user_code: data.user_code }, 'Device code issued');
    res.json(data);
  } catch (error) {
    logger.error({ error: error.message }, 'Device code proxy error');
    res.status(500).json({ error: 'Failed to get device code', error_description: error.message });
  }
});

// Proxy for token polling
app.post('/auth/microsoft/token', async (req, res) => {
  const { client_id, device_code, grant_type, tenant = 'organizations' } = req.body;

  if (!client_id || !device_code) {
    return res.status(400).json({ error: 'client_id and device_code are required' });
  }

  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id,
          grant_type: grant_type || 'urn:ietf:params:oauth:grant-type:device_code',
          device_code
        })
      }
    );

    const data = await response.json();

    if (!response.ok && data.error !== 'authorization_pending' && data.error !== 'slow_down') {
      logger.warn({ error: data.error }, 'Azure AD token error');
    }

    // Return the response as-is (including authorization_pending errors)
    res.status(response.ok ? 200 : response.status).json(data);
  } catch (error) {
    logger.error({ error: error.message }, 'Token proxy error');
    res.status(500).json({ error: 'Failed to get token', error_description: error.message });
  }
});

// Helper function to call Microsoft Graph API
async function callGraphAPI(endpoint, options = {}) {
  if (!msGraphTokens.current) {
    throw new Error('No Microsoft account signed in. Please sign in from the room display.');
  }

  if (Date.now() > msGraphTokens.current.expiresAt) {
    throw new Error('Microsoft token expired. Please sign in again from the room display.');
  }

  const url = endpoint.startsWith('http') ? endpoint : `https://graph.microsoft.com/v1.0${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${msGraphTokens.current.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(error.error?.message || `Graph API error: ${response.status}`);
  }

  return response.json();
}

// Streamable HTTP transport - session management
const transports = new Map();

// MCP endpoint using Streamable HTTP transport
app.post('/mcp', authMiddleware, async (req, res) => {
  logger.info({ ip: req.ip, sessionId: req.headers['mcp-session-id'] }, 'MCP request received');

  const sessionId = req.headers['mcp-session-id'];
  let transport = transports.get(sessionId);

  if (!transport) {
    // New session - create transport
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
        logger.info({ sessionId: newSessionId }, 'MCP session initialized');
      }
    });

    // Connect to MCP server
    await server.connect(transport);

    // Handle session close
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        logger.info({ sessionId: transport.sessionId }, 'MCP session closed');
      }
    };
  }

  // Handle the request
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
    // Silently ignore ERR_HTTP_HEADERS_SENT - response already sent
  }
});

// GET endpoint for SSE notifications (optional, for server-initiated messages)
app.get('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = transports.get(sessionId);

  if (!transport) {
    return res.status(400).json({ error: 'No active session. Send POST to /mcp first.' });
  }

  // Handle SSE connection - transport sets up headers
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// DELETE endpoint for session termination
app.delete('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = transports.get(sessionId);

  if (transport) {
    await transport.close();
    transports.delete(sessionId);
    logger.info({ sessionId }, 'MCP session terminated');
  }

  res.status(200).json({ success: true });
});

// Main
async function main() {
  logger.info({ config: { port: CONFIG.httpPort, wsHost: CONFIG.websocketHost, wsPort: CONFIG.websocketPort } }, 'Starting BUControl MCP HTTP Server');

  const httpServer = app.listen(CONFIG.httpPort, CONFIG.bindAddress, () => {
    logger.info({ address: `${CONFIG.bindAddress}:${CONFIG.httpPort}` }, 'HTTP server listening');
  });

  // Connect to WebSocket in background with retry logic
  async function connectWithRetry(maxRetries = 10) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await initWebSocket();
        logger.info('WebSocket initialized successfully');
        return;
      } catch (e) {
        const delay = calculateBackoff(attempt);
        logger.warn({ error: e.message, attempt, maxRetries, nextRetryMs: delay }, 'WebSocket init failed, retrying...');
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    logger.error({ maxRetries }, 'WebSocket init failed after all retries - will rely on manual reconnect');
  }

  connectWithRetry();

  // Periodic health check - reconnect if disconnected
  setInterval(() => {
    if (!isConnected && socket) {
      logger.info('Health check: WebSocket disconnected, attempting reconnect...');
      socket.connect();
    }
  }, 30000); // Check every 30 seconds

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
