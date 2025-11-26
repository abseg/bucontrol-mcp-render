#!/usr/bin/env node
/**
 * BUControl MCP Server - Unified Version
 * Uses shared tools, single WebSocket, multiple transports
 * Full feature parity with server-http.js + improved architecture
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { randomUUID, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { Readable } from 'stream';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

// Shared modules
import wsManager from './shared/clientWebSocketForV2.js';
import {
  initializeTools,
  getMcpToolDefinitions,
  getVapiToolDefinitions,
  executeTool,
  formatMcpResult
} from './tools/index.js';
import { setTokenStorage } from './tools/user.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dirname, '.ms-graph-token.json');

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  } : undefined,
  base: { service: 'bucontrol-mcp', version: '2.0.0' }
});

// Configuration - Full parity with server-http.js
const CONFIG = {
  httpPort: parseInt(process.env.PORT || process.env.HTTP_PORT || '3100'),
  httpsPort: parseInt(process.env.HTTPS_PORT || '3101'),
  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',
  controllerId: process.env.CONTROLLER_ID || 'modular-controller-config',
  websocketHost: process.env.WEBSOCKET_HOST || '100.71.254.15',
  websocketPort: parseInt(process.env.WEBSOCKET_PORT || '3004'),
  enableDebug: process.env.ENABLE_DEBUG === 'true',
  // Timeouts
  reconnectionDelayBase: parseInt(process.env.RECONNECTION_DELAY_BASE || '1000'),
  reconnectionDelayMax: parseInt(process.env.RECONNECTION_DELAY_MAX || '30000'),
  reconnectionAttempts: parseInt(process.env.RECONNECTION_ATTEMPTS || '0'),
  connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '20000'),
  identifyTimeout: parseInt(process.env.IDENTIFY_TIMEOUT || '5000'),
  commandTimeout: parseInt(process.env.COMMAND_TIMEOUT || '10000'),
  discoveryTimeout: parseInt(process.env.DISCOVERY_TIMEOUT || '10000')
};

// Security - Full parity with server-http.js
const SECURITY = {
  apiKeys: new Map(),
  oauthClients: new Map(),
  requireApiKey: process.env.REQUIRE_API_KEY !== 'false',
  corsOrigins: process.env.CORS_ORIGINS || '*',
  // Rate limit tiers
  rateLimitTiers: {
    free: { windowMs: 60000, max: 30 },
    basic: { windowMs: 60000, max: 100 },
    premium: { windowMs: 60000, max: 500 },
    unlimited: { windowMs: 60000, max: 10000 }
  },
  defaultRateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100')
  },
  // OAuth 2.0 configuration
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

// Parse API keys (format: key:tier)
(process.env.API_KEYS || '').split(',').filter(k => k.length > 0).forEach(entry => {
  const [key, tier] = entry.split(':');
  SECURITY.apiKeys.set(key.trim(), tier?.trim() || 'basic');
});

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

// Authorization codes storage for PKCE flow
const authorizationCodes = new Map();

// Calculate exponential backoff with jitter
function calculateBackoff(attempt) {
  return Math.min(CONFIG.reconnectionDelayBase * Math.pow(2, attempt), CONFIG.reconnectionDelayMax) * (1 + Math.random() * 0.25);
}

// Microsoft Graph token storage
const msGraphTokens = {
  current: null,
  history: []
};

// Connect token storage to user tools
setTokenStorage(msGraphTokens);

// Load persisted token
function loadPersistedToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      if (data.expiresAt && Date.now() < data.expiresAt) {
        msGraphTokens.current = data;
        logger.info({ user: data.user?.displayName }, 'Loaded persisted Microsoft token');
        return true;
      }
    }
  } catch (e) {
    logger.error({ error: e.message }, 'Failed to load persisted token');
  }
  return false;
}

function savePersistedToken() {
  try {
    if (msGraphTokens.current) {
      writeFileSync(TOKEN_FILE, JSON.stringify(msGraphTokens.current, null, 2));
    }
  } catch (e) {
    logger.error({ error: e.message }, 'Failed to persist token');
  }
}

loadPersistedToken();

// Initialize tools
initializeTools();

// Session Manager - Full parity with server-http.js
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  create(clientInfo = {}) {
    const id = uuidv4();
    const session = {
      id,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      clientInfo,
      requestCount: 0,
      transport: null
    };
    this.sessions.set(id, session);
    metrics.activeSessions.set(id, session);
    metrics.totalSessions++;
    logger.info({ sessionId: id }, 'Session created');
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  update(id, data = {}) {
    const session = this.sessions.get(id);
    if (session) {
      Object.assign(session, data, { lastActivity: Date.now() });
      session.requestCount++;
    }
    return session;
  }

  destroy(id) {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      metrics.activeSessions.delete(id);
      logger.info({ sessionId: id }, 'Session destroyed');
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > 1800000) { // 30 minutes
        this.destroy(id);
      }
    }
  }

  close() {
    clearInterval(this.cleanupInterval);
    this.sessions.clear();
    metrics.activeSessions.clear();
  }
}

const sessionManager = new SessionManager();

// Metrics - Full parity with server-http.js
const metrics = {
  startTime: Date.now(),
  requestCount: 0,
  errorCount: 0,
  websocketConnections: 0,
  websocketReconnections: 0,
  websocketErrors: 0,
  toolCalls: new Map(),
  toolErrors: new Map(),
  activeSessions: new Map(),
  totalSessions: 0,
  rateLimitHits: 0
};

// MCP Server
const server = new Server(
  { name: 'bucontrol-unified', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getMcpToolDefinitions()
}));

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  metrics.toolCalls.set(name, (metrics.toolCalls.get(name) || 0) + 1);

  try {
    const result = await executeTool(name, args, { transport: 'mcp' });
    return formatMcpResult(result);
  } catch (e) {
    metrics.errorCount++;
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
      isError: true
    };
  }
});

// Express App
const app = express();

// Trust proxy - needed for X-Forwarded-For headers from Clever Cloud
app.set('trust proxy', true);

// Tailscale-only access control
const TAILSCALE_ONLY = process.env.TAILSCALE_ONLY === 'true';

function isLocalOrTailscaleIP(ip) {
  const cleanIp = ip.replace(/^::ffff:/, '');

  // Localhost
  if (cleanIp === '127.0.0.1' || cleanIp === '::1') return true;

  // Docker/internal networks (172.17.x.x, 10.x.x.x)
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(cleanIp)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(cleanIp)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(cleanIp)) return true;

  // All 100.x.x.x IPs (Tailscale uses CGNAT range 100.64-127, but be permissive)
  if (/^100\.\d+\.\d+\.\d+$/.test(cleanIp)) return true;

  return false;
}

function tailscaleOnlyMiddleware(req, res, next) {
  if (!TAILSCALE_ONLY) return next();

  // Get client IP - trust proxy is enabled so req.ip should be accurate
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = req.ip || forwardedFor?.split(',')[0].trim() ||
                   req.connection?.remoteAddress || '';

  // Log for debugging
  logger.debug({
    clientIp,
    forwardedFor,
    reqIp: req.ip,
    remoteAddr: req.connection?.remoteAddress,
    path: req.path
  }, 'Tailscale check');

  if (isLocalOrTailscaleIP(clientIp)) {
    return next();
  }

  logger.warn({ ip: clientIp, forwardedFor, path: req.path }, 'Blocked non-Tailscale request');
  return res.status(403).json({
    error: 'Access denied',
    message: 'This server is only accessible via Tailscale VPN'
  });
}

app.use(cors({
  origin: SECURITY.corsOrigins === '*' ? true : SECURITY.corsOrigins.split(','),
  credentials: true,
  exposedHeaders: ['mcp-session-id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { metrics.requestCount++; next(); });

// Apply Tailscale-only restriction to all routes
app.use(tailscaleOnlyMiddleware);

// Serve static files from public folder (voice assistant UI)
app.use(express.static(join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: SECURITY.defaultRateLimit.windowMs,
  max: SECURITY.defaultRateLimit.max,
  message: { error: 'Rate limit exceeded' }
});
app.use('/mcp', limiter);

// Auth middleware
function isLocalRequest(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  // Check for localhost, IPv4 private ranges, IPv6 localhost, and Tailscale (100.x.x.x)
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' ||
    /^192\.168\.\d+\.\d+$/.test(ip) || /^::ffff:192\.168\.\d+\.\d+$/.test(ip) ||
    /^10\.\d+\.\d+\.\d+$/.test(ip) || /^::ffff:10\.\d+\.\d+\.\d+$/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip) ||
    /^100\.\d+\.\d+\.\d+$/.test(ip) || /^::ffff:100\.\d+\.\d+\.\d+$/.test(ip);
}

async function authMiddleware(req, res, next) {
  if (!SECURITY.requireApiKey && !SECURITY.oauth.enabled) return next();

  // Skip auth for local network requests (kiosk displays)
  if (isLocalRequest(req)) {
    req.auth = { type: 'local', tier: 'basic' };
    return next();
  }

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

  req.auth = { type: 'apikey', tier: SECURITY.apiKeys.get(key) };
  req.apiKeyTier = req.auth.tier;
  next();
}

// Health endpoints
app.get('/health', (req, res) => res.json({
  status: wsManager.isConnected && wsManager.isIdentified ? 'healthy' : 'degraded',
  websocket: { connected: wsManager.isConnected, identified: wsManager.isIdentified },
  components: Object.keys(wsManager.discoveredComponents.list).length,
  uptime: Math.floor((Date.now() - metrics.startTime) / 1000)
}));
app.get('/ready', (req, res) => wsManager.isConnected && wsManager.isIdentified
  ? res.json({ ready: true })
  : res.status(503).json({ ready: false }));
app.get('/live', (req, res) => res.json({ alive: true }));

// Metrics endpoint - Full parity with server-http.js
app.get('/metrics', (req, res) => {
  const toolCallsStr = Array.from(metrics.toolCalls.entries())
    .map(([k, v]) => `mcp_tool_calls{tool="${k}"} ${v}`).join('\n');
  res.type('text/plain').send(`# HELP mcp_requests_total Total requests
mcp_requests_total ${metrics.requestCount}
# HELP mcp_errors_total Total errors
mcp_errors_total ${metrics.errorCount}
# HELP mcp_websocket_connected WebSocket status
mcp_websocket_connected ${wsManager.isConnected ? 1 : 0}
# HELP mcp_components_discovered Discovered components
mcp_components_discovered ${Object.keys(wsManager.discoveredComponents.list).length}
# HELP mcp_sessions_active Active sessions
mcp_sessions_active ${sessionManager.sessions.size}
# HELP mcp_uptime_seconds Uptime
mcp_uptime_seconds ${Math.floor((Date.now() - metrics.startTime) / 1000)}
${toolCallsStr}`);
});

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
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

// OAuth authorization endpoint with PKCE
app.get('/authorize', (req, res) => {
  if (!SECURITY.oauth.enabled) {
    return res.status(400).json({ error: 'oauth_disabled', error_description: 'OAuth is not enabled' });
  }

  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query;

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

  // Generate authorization code
  const code = randomUUID();
  authorizationCodes.set(code, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method: code_challenge_method || 'S256',
    scope: scope || '',
    expires: Date.now() + 600000 // 10 minutes
  });

  logger.info({ client_id, scope }, 'Authorization code generated');

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.redirect(redirectUrl.toString());
});

// OAuth token endpoint (authorization_code and client_credentials)
app.post('/oauth/token', (req, res) => {
  if (!SECURITY.oauth.enabled) {
    return res.status(400).json({ error: 'oauth_disabled', error_description: 'OAuth is not enabled' });
  }

  const { grant_type, client_id, client_secret, code, code_verifier, redirect_uri } = req.body;

  // Authorization Code grant (PKCE)
  if (grant_type === 'authorization_code') {
    if (!code) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
    }
    if (!code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier is required for PKCE' });
    }

    const authCode = authorizationCodes.get(code);
    if (!authCode) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
    }
    authorizationCodes.delete(code); // One-time use

    if (Date.now() > authCode.expires) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
    }
    if (client_id && client_id !== authCode.client_id) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    }
    if (redirect_uri && redirect_uri !== authCode.redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // Verify PKCE
    const expectedChallenge = createHash('sha256').update(code_verifier).digest('base64url');
    if (expectedChallenge !== authCode.code_challenge) {
      logger.warn({ client_id: authCode.client_id }, 'PKCE verification failed');
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    const client = SECURITY.oauthClients.get(authCode.client_id);
    const tier = client?.tier || 'basic';

    const token = jwt.sign(
      { sub: authCode.client_id, tier, type: 'access_token', scope: authCode.scope },
      SECURITY.oauth.secret,
      { algorithm: 'HS256', expiresIn: SECURITY.oauth.tokenExpiry }
    );

    logger.info({ client_id: authCode.client_id, tier }, 'OAuth token issued via authorization_code');
    return res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400 });
  }

  // Client Credentials grant
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

    const token = jwt.sign(
      { sub: client_id, tier: client.tier, type: 'access_token' },
      SECURITY.oauth.secret,
      { algorithm: 'HS256', expiresIn: SECURITY.oauth.tokenExpiry }
    );

    logger.info({ client_id, tier: client.tier }, 'OAuth token issued via client_credentials');
    return res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400 });
  }

  return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Supported: authorization_code, client_credentials' });
});

// Voice Assistant Orb UI endpoint
app.get('/orb', (req, res) => {
  try {
    const orbPath = join(__dirname, '..', '..', 'tools', 'bucontrolVoiceAssistantOrb.html');
    const html = readFileSync(orbPath, 'utf8');
    res.type('html').send(html);
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to serve orb HTML');
    res.status(500).send('Failed to load orb interface');
  }
});

// Microsoft auth endpoints
app.post('/auth/microsoft', (req, res) => {
  const { accessToken, refreshToken, expiresIn, user } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

  msGraphTokens.current = {
    accessToken, refreshToken,
    expiresAt: Date.now() + (expiresIn || 3600) * 1000,
    user, receivedAt: Date.now()
  };
  msGraphTokens.history.push({ user: user?.displayName, timestamp: Date.now() });
  if (msGraphTokens.history.length > 50) msGraphTokens.history = msGraphTokens.history.slice(-50);

  savePersistedToken();
  logger.info({ user: user?.displayName }, 'Microsoft token received');
  res.json({ success: true, user: user?.displayName });
});

app.get('/auth/microsoft', (req, res) => {
  if (!msGraphTokens.current) return res.json({ authenticated: false });
  const isExpired = Date.now() > msGraphTokens.current.expiresAt;
  res.json({
    authenticated: !isExpired,
    user: msGraphTokens.current.user?.displayName,
    expiresAt: msGraphTokens.current.expiresAt,
    isExpired
  });
});

// Azure AD proxy endpoints
app.post('/auth/microsoft/devicecode', async (req, res) => {
  const { client_id, scope, tenant = 'organizations' } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id, scope: scope || 'User.Read Files.Read offline_access' })
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    logger.info({ user_code: data.user_code }, 'Device code issued');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/microsoft/token', async (req, res) => {
  const { client_id, device_code, tenant = 'organizations' } = req.body;
  if (!client_id || !device_code) return res.status(400).json({ error: 'client_id and device_code required' });

  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code
        })
      }
    );
    const data = await response.json();
    res.status(response.ok ? 200 : response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/auth/devicelogin', (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('https://microsoft.com/devicelogin');
  res.type('html').send(`<!DOCTYPE html><html><head><title>Signing in...</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
.loader{text-align:center}.spinner{width:40px;height:40px;border:3px solid #e0e0e0;border-top:3px solid #0078d4;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="loader"><div class="spinner"></div><p>Redirecting to Microsoft...</p></div>
<form id="f" method="POST" action="https://login.microsoftonline.com/common/oauth2/deviceauth">
<input type="hidden" name="otc" value="${code.replace(/[^A-Z0-9]/gi, '')}"></form>
<script>document.getElementById('f').submit();</script></body></html>`);
});

// File download proxy
app.get('/files/:fileId/download', async (req, res) => {
  const { fileId } = req.params;
  if (!msGraphTokens.current?.accessToken) {
    return res.status(401).json({ error: 'Not authenticated with Microsoft' });
  }

  try {
    const metaResponse = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
      headers: { 'Authorization': `Bearer ${msGraphTokens.current.accessToken}` }
    });
    if (!metaResponse.ok) throw new Error('File not found');
    const metadata = await metaResponse.json();

    const contentResponse = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/content`, {
      headers: { 'Authorization': `Bearer ${msGraphTokens.current.accessToken}` },
      redirect: 'follow'
    });
    if (!contentResponse.ok) throw new Error('Download failed');

    res.setHeader('Content-Type', metadata.file?.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(metadata.name)}"`);
    if (metadata.size) res.setHeader('Content-Length', metadata.size);

    // Convert Web ReadableStream to Node.js Readable stream
    const nodeStream = Readable.fromWeb(contentResponse.body);

    // Pipe to response
    nodeStream.pipe(res);

    // Handle stream completion (full parity with server-http.js)
    nodeStream.on('end', () => {
      logger.info({ fileId, fileName: metadata.name }, 'File downloaded via proxy');
    });

    nodeStream.on('error', (err) => {
      logger.error({ error: err.message, fileId }, 'Stream error during file download');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      }
    });
  } catch (error) {
    logger.error({ error: error.message, fileId }, 'File download proxy error');
    res.status(500).json({ error: error.message });
  }
});

// Smart error mapping for voice responses (user-friendly messages)
function mapErrorToVoice(error) {
  if (error.message.includes('Timeout') || error.message.includes('timeout')) {
    return 'System not responding.';
  }
  if (error.message.includes('Not connected') || error.message.includes('not connected')) {
    return 'Connection lost.';
  }
  if (error.message.includes('Component not found')) {
    return 'Device not available.';
  }
  return 'Command failed.';
}

// Voice webhook
app.post('/voice/webhook', authMiddleware, async (req, res) => {
  const { message } = req.body;

  // Detailed request logging for debugging (full parity with voice-endpoint.js)
  logger.info({
    type: message?.type,
    callId: req.headers['x-call-id'],
    body: JSON.stringify(req.body).substring(0, 500)
  }, 'VAPI request received');

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
      const result = await executeTool(toolName, args, { transport: 'voice' });
      results.push({ toolCallId: toolId, result });
      logger.info({ tool: toolName, result }, 'Tool executed');
    } catch (error) {
      // Use smart error mapping for user-friendly voice responses
      const errorMsg = mapErrorToVoice(error);
      results.push({ toolCallId: toolId, error: errorMsg });
      logger.error({ tool: toolName, error: error.message }, 'Tool error');
    }
  }

  res.json({ results });
});

app.get('/voice/tools', authMiddleware, (req, res) => {
  res.json(getVapiToolDefinitions());
});

app.get('/voice/health', (req, res) => {
  res.json({
    status: wsManager.isConnected && wsManager.isIdentified ? 'healthy' : 'degraded',
    connected: wsManager.isConnected,
    identified: wsManager.isIdentified
  });
});

// MCP Streamable HTTP transport
const transports = new Map();

app.use('/mcp', (req, res, next) => {
  if (!req.headers.accept || req.headers.accept === '*/*') {
    req.headers.accept = 'application/json, text/event-stream';
  }
  next();
});

app.post('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport = transports.get(sessionId);

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
        logger.info({ sessionId: newSessionId }, 'MCP session initialized');
      }
    });
    await server.connect(transport);
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/mcp', authMiddleware, async (req, res) => {
  const transport = transports.get(req.headers['mcp-session-id']);
  if (!transport) return res.status(400).json({ error: 'No active session' });
  try { await transport.handleRequest(req, res); }
  catch (error) { if (!res.headersSent) res.status(500).json({ error: error.message }); }
});

app.delete('/mcp', authMiddleware, async (req, res) => {
  const transport = transports.get(req.headers['mcp-session-id']);
  if (transport) { await transport.close(); transports.delete(req.headers['mcp-session-id']); }
  res.json({ success: true });
});

// Main
async function main() {
  logger.info({ config: { port: CONFIG.httpPort, wsHost: CONFIG.websocketHost, wsPort: CONFIG.websocketPort } }, 'Starting BUControl Unified MCP Server');

  // Validate configuration
  if (SECURITY.requireApiKey && SECURITY.apiKeys.size === 0) {
    logger.error('REQUIRE_API_KEY is enabled but no API keys configured. Set API_KEYS env var or disable requirement.');
    process.exit(1);
  }

  // Start HTTP server
  const httpServer = app.listen(CONFIG.httpPort, CONFIG.bindAddress, () => {
    logger.info({ address: `${CONFIG.bindAddress}:${CONFIG.httpPort}` }, 'HTTP server listening');

    if (SECURITY.requireApiKey) {
      logger.info({ keyCount: SECURITY.apiKeys.size }, 'API key authentication ENABLED');
    } else {
      logger.warn('API key authentication DISABLED');
    }

    if (SECURITY.oauth.enabled) {
      logger.info('OAuth 2.0 authentication ENABLED');
    }
  });

  // Start HTTPS server
  const SSL_CERT_PATH = join(__dirname, '..', '..', 'server', 'certs', 'server.cert');
  const SSL_KEY_PATH = join(__dirname, '..', '..', 'server', 'certs', 'server.key');

  if (existsSync(SSL_CERT_PATH) && existsSync(SSL_KEY_PATH)) {
    const httpsServer = https.createServer({
      cert: readFileSync(SSL_CERT_PATH),
      key: readFileSync(SSL_KEY_PATH)
    }, app);
    httpsServer.listen(CONFIG.httpsPort, CONFIG.bindAddress, () => {
      logger.info({ address: `${CONFIG.bindAddress}:${CONFIG.httpsPort}` }, 'HTTPS server listening');
    });
  } else {
    logger.warn('SSL certificates not found, HTTPS server not started');
  }

  // Connect WebSocket with retry and proper backoff
  async function connectWithRetry(maxRetries = 10) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await wsManager.init(CONFIG);
        logger.info('WebSocket initialized successfully');
        metrics.websocketConnections++;
        return;
      } catch (e) {
        metrics.websocketErrors++;
        const delay = calculateBackoff(attempt);
        logger.warn({ error: e.message, attempt, maxRetries, nextRetryMs: delay }, 'WebSocket init failed, retrying...');
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, delay));
      }
    }
    logger.error({ maxRetries }, 'WebSocket init failed after all retries - will rely on manual reconnect');
  }

  connectWithRetry();

  // Periodic health check - reconnect if disconnected
  setInterval(() => {
    if (!wsManager.isConnected && wsManager.socket) {
      logger.info('Health check: WebSocket disconnected, attempting reconnect...');
      wsManager.socket.connect();
      metrics.websocketReconnections++;
    }
  }, 30000);

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    sessionManager.close();
    wsManager.disconnect();
    httpServer.close(() => { logger.info('Server closed'); process.exit(0); });
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => {
    logger.fatal({ error: e.message }, 'Uncaught exception');
    if (process.env.NODE_ENV !== 'production') process.exit(1);
  });
  process.on('unhandledRejection', (r) => logger.error({ reason: r }, 'Unhandled rejection'));
}

main().catch(e => { logger.fatal({ error: e.message }, 'Failed to start'); process.exit(1); });
