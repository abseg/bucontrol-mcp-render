# BUControl MCP Server - Security Guide

## Table of Contents
- [Quick Start (Secure)](#quick-start-secure)
- [Exposure Levels](#exposure-levels)
- [Authentication](#authentication)
- [Network Configuration](#network-configuration)
- [Testing Access](#testing-access)
- [Security Checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

## Quick Start (Secure)

### 1. Initial Setup

```bash
# Navigate to server directory
cd packages/mcp-bucontrol-server

# Copy environment template
cp .env.example .env

# Generate a secure API key (Windows)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Or on Linux/Mac
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 2. Configure .env

Edit `.env` and set:

```env
# REQUIRED: Add your generated API key
API_KEYS=YOUR_GENERATED_KEY_HERE

# REQUIRED: Set network binding (VPN recommended)
BIND_ADDRESS=100.71.254.15

# OPTIONAL: Configure CORS
ALLOWED_ORIGINS=https://claude.ai,https://localhost:3443

# OPTIONAL: Enable audit logging
ENABLE_AUDIT_LOG=true
```

### 3. Start Server

```bash
# Windows
start-secure.bat

# Linux/Mac
npm run start:remote
```

## Exposure Levels

### Level 1: NOT EXPOSED (Most Secure)
**Use for:** Testing, development

```env
BIND_ADDRESS=127.0.0.1
```

✅ Only accessible from same machine
❌ Cannot access from other devices

### Level 2: VPN-ONLY (Recommended)
**Use for:** Production with Tailscale VPN

```env
BIND_ADDRESS=100.71.254.15
```

✅ Only accessible via Tailscale VPN
✅ Encrypted tunnel
✅ Multi-device access (iPad, phone, laptop)
❌ Requires Tailscale on all clients

### Level 3: LOCAL NETWORK
**Use for:** Trusted private network only

```env
BIND_ADDRESS=192.168.100.53
```

⚠️ Accessible to anyone on your WiFi
⚠️ Requires strong API key authentication
❌ Not recommended for sensitive environments

### Level 4: FULLY EXPOSED (Dangerous)
**Use for:** Never! (or public demo with heavy security)

```env
BIND_ADDRESS=0.0.0.0
```

❌ Exposed to all network interfaces
❌ High attack surface
❌ Requires firewall rules

## Authentication

### API Key Methods

The server accepts API keys via three methods:

**1. HTTP Header (Recommended)**
```bash
curl -H "x-api-key: YOUR_API_KEY" http://100.71.254.15:3100/health
```

**2. Authorization Bearer Token**
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" http://100.71.254.15:3100/health
```

**3. Query Parameter (Less secure - only for testing)**
```bash
curl http://100.71.254.15:3100/health?api_key=YOUR_API_KEY
```

### Multiple API Keys

Support multiple clients with different keys:

```env
API_KEYS=key1-for-ipad,key2-for-desktop,key3-for-mobile
```

## Network Configuration

### Check Current Exposure

```bash
# Windows
netstat -ano | findstr "3100"
netstat -ano | findstr "3443"

# Linux/Mac
netstat -an | grep 3100
netstat -an | grep 3443
```

Look for the binding address:
- `127.0.0.1:3100` = Localhost only
- `100.71.254.15:3100` = VPN only
- `192.168.100.53:3100` = Local network
- `0.0.0.0:3100` = All interfaces (exposed!)

### Firewall Rules (Optional)

**Windows Firewall - VPN Only:**
```powershell
# Allow only from Tailscale subnet
New-NetFirewallRule -DisplayName "MCP Server - Tailscale Only" `
  -Direction Inbound -LocalPort 3100,3443 -Protocol TCP `
  -Action Allow -RemoteAddress 100.64.0.0/10

# Block from other sources
New-NetFirewallRule -DisplayName "MCP Server - Block Others" `
  -Direction Inbound -LocalPort 3100,3443 -Protocol TCP `
  -Action Block
```

## Testing Access

### 1. Health Check (No Auth Required)

```bash
curl http://100.71.254.15:3100/health
```

Expected response:
```json
{
  "status": "ok",
  "websocket": "connected",
  "identified": true,
  "components": ["videoWall", "hdmiDisplay", "gpio", ...]
}
```

### 2. Authenticated Request

```bash
curl -H "x-api-key: YOUR_API_KEY" \
     http://100.71.254.15:3100/sse
```

### 3. Test from iPad (Tailscale)

1. Install Tailscale on iPad
2. Connect to your Tailnet
3. Open Safari to: `http://100.71.254.15:3100/health`
4. Should see health check response

## Security Checklist

Before exposing to network:

- [ ] API keys configured in `.env`
- [ ] API keys are strong (32+ random bytes)
- [ ] `BIND_ADDRESS` set to VPN IP (not 0.0.0.0)
- [ ] `ALLOWED_ORIGINS` configured
- [ ] Audit logging enabled
- [ ] Rate limiting configured
- [ ] Tested health check endpoint
- [ ] Tested authenticated request
- [ ] SSL certificates generated (for HTTPS)
- [ ] Firewall rules configured (if needed)
- [ ] `.env` file NOT committed to git

## Monitoring

### View Audit Logs

```bash
# Windows
type audit.log

# Linux/Mac
tail -f audit.log
```

### Monitor Failed Authentication

```bash
# Windows
findstr "auth_invalid" audit.log

# Linux/Mac
grep "auth_invalid" audit.log
```

### Monitor Rate Limiting

```bash
# Windows
findstr "rate_limit_exceeded" audit.log

# Linux/Mac
grep "rate_limit_exceeded" audit.log
```

## Troubleshooting

### "Unauthorized" Error

**Problem:** Getting 401 Unauthorized

**Solutions:**
1. Check API key is correct
2. Ensure header name is `x-api-key` (lowercase)
3. Verify key matches `.env` file
4. Check for extra spaces/newlines in key

### "Connection Refused"

**Problem:** Cannot connect to server

**Solutions:**
1. Verify server is running: `netstat -ano | findstr 3100`
2. Check `BIND_ADDRESS` in `.env`
3. Ensure you're connecting from allowed network
4. Test with `curl http://BIND_ADDRESS:3100/health`

### "CORS Error"

**Problem:** Browser showing CORS error

**Solutions:**
1. Add origin to `ALLOWED_ORIGINS` in `.env`
2. Restart server after changing `.env`
3. Check browser console for blocked origin
4. For testing, temporarily add `*` to allowed origins

### "Rate Limit Exceeded"

**Problem:** Too many requests

**Solutions:**
1. Wait 60 seconds for rate limit window to reset
2. Increase `RATE_LIMIT_MAX_REQUESTS` in `.env`
3. Check for loops/automation making excessive requests

### SSL Certificate Errors

**Problem:** HTTPS not working

**Solutions:**
1. Generate self-signed certificate:
   ```bash
   openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.cert -days 365 -nodes
   ```
2. Accept certificate warning in browser
3. Or use HTTP endpoint instead (port 3100)

## Advanced Security

### IP Whitelisting

Add to [server.js](server.js) after API key check:

```javascript
const ALLOWED_IPS = ['100.71.254.15', '192.168.100.53'];

app.use((req, res, next) => {
  if (!ALLOWED_IPS.includes(req.ip)) {
    return res.status(403).json({ error: 'IP not allowed' });
  }
  next();
});
```

### Session Management

Current configuration allows:
- 3 concurrent sessions per API key
- 24-hour session timeout

Modify in `.env`:
```env
MAX_SESSIONS_PER_CLIENT=3
SESSION_TIMEOUT_HOURS=24
```

### Rotate API Keys

1. Generate new key
2. Add to `.env`: `API_KEYS=old_key,new_key`
3. Update clients to use new key
4. Remove old key from `.env`

## Production Recommendations

1. **Use Tailscale VPN** - Best balance of security and convenience
2. **Enable audit logging** - Track all control actions
3. **Use HTTPS** - Encrypt traffic (even on VPN)
4. **Strong API keys** - 32+ bytes, generated with crypto.randomBytes
5. **Monitor logs** - Watch for suspicious activity
6. **Regular key rotation** - Change API keys periodically
7. **Principle of least privilege** - Only expose what's needed
8. **Firewall rules** - Defense in depth
