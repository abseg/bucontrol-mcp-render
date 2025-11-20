# MCP BUControl Server - Security Setup Complete ✅

## Current Status

### ✅ Server is NOT Currently Exposed
- Ports 3100 and 3443 are **CLOSED** (server stopped for configuration)
- Server successfully tested with VPN-only binding
- All security measures implemented and tested

### 🔒 Security Features Implemented

1. **API Key Authentication** - All endpoints (except /health) require valid API key
2. **VPN-Only Binding** - Server binds to Tailscale IP (100.71.254.15) only
3. **Rate Limiting** - Maximum 100 requests per minute per client
4. **Strict CORS** - Only allows requests from configured origins
5. **Input Validation** - WindowCommand format and geometry validation
6. **Audit Logging** - All control actions logged to audit.log
7. **Security Warnings** - Startup script checks for unsafe configurations

## Your Network Configuration

**Tailscale VPN:** `100.71.254.15` ← **RECOMMENDED FOR EXPOSURE**
**Local LAN:** `192.168.100.53`
**Localhost:** `127.0.0.1`

## How to Start the Secure Server

### Option 1: Windows (Recommended)
```batch
cd packages\mcp-bucontrol-server
start-secure.bat
```
The startup script will:
- Check for .env configuration
- Verify API keys are set
- Warn if binding to 0.0.0.0
- Display current security settings
- Start the server

### Option 2: Direct NPM
```bash
cd packages/mcp-bucontrol-server
npm run start:remote
```

## Your API Key

**Location:** `packages/mcp-bucontrol-server/.env`
**Current Key:** `Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=`

⚠️ **Keep this secret!** Don't commit .env to git (already in .gitignore)

## How to Connect

### From iPad (via Tailscale)

1. **Install Tailscale on iPad**
   - Download from App Store
   - Sign in with same account
   - Connect to your Tailnet

2. **Test Connection**
   ```
   Safari → http://100.71.254.15:3100/health
   ```
   Should see: `{"status":"ok","websocket":"connected",...}`

3. **Configure Claude Desktop or MCP Client**
   - URL: `http://100.71.254.15:3100/sse`
   - Add header: `x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=`

### From Local Machine

```bash
# Health check (no auth)
curl http://100.71.254.15:3100/health

# Authenticated request
curl -H "x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=" \
     http://100.71.254.15:3100/sse
```

## Exposure Levels (How to Change)

Edit `packages/mcp-bucontrol-server/.env` and change `BIND_ADDRESS`:

### Current: VPN-ONLY (Recommended) ✅
```env
BIND_ADDRESS=100.71.254.15
```
- Only accessible via Tailscale VPN
- Encrypted tunnel
- Multi-device access (iPad, phone, laptop)

### Alternative: LOCALHOST (Testing Only)
```env
BIND_ADDRESS=127.0.0.1
```
- Only accessible from same machine
- Safest for development

### Alternative: LOCAL NETWORK (Moderate Risk)
```env
BIND_ADDRESS=192.168.100.53
```
- Accessible to anyone on your WiFi
- Requires strong authentication

### ⚠️ NEVER USE: ALL INTERFACES
```env
BIND_ADDRESS=0.0.0.0
```
- Exposed to all network interfaces
- High security risk

## Monitoring

### View Server Logs
```bash
# Windows
cd packages\mcp-bucontrol-server
type audit.log

# Check for failed auth attempts
findstr "auth_invalid" audit.log

# Check for rate limiting
findstr "rate_limit_exceeded" audit.log
```

### Check Current Exposure
```bash
netstat -ano | findstr "3100"
```

Look for:
- `100.71.254.15:3100` = VPN only ✅
- `0.0.0.0:3100` = All interfaces ⚠️

## Testing Security

### Test 1: Health Check (Should Work)
```bash
curl http://100.71.254.15:3100/health
```
Expected: `{"status":"ok",...}`

### Test 2: Protected Endpoint Without Auth (Should Fail)
```bash
curl http://100.71.254.15:3100/sse
```
Expected: `{"error":"Unauthorized",...}`

### Test 3: Protected Endpoint With Auth (Should Work)
```bash
curl -H "x-api-key: YOUR_KEY_HERE" http://100.71.254.15:3100/sse
```
Expected: SSE stream starts

## Generate New API Keys

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then update `.env`:
```env
API_KEYS=new_key_1,new_key_2,new_key_3
```

## Files Modified

✅ `packages/mcp-bucontrol-server/server.js` - Added all security features
✅ `packages/mcp-bucontrol-server/.env` - Configuration (NOT in git)
✅ `packages/mcp-bucontrol-server/.env.example` - Template
✅ `packages/mcp-bucontrol-server/.gitignore` - Excludes .env and audit.log
✅ `packages/mcp-bucontrol-server/package.json` - Added security dependencies
✅ `packages/mcp-bucontrol-server/start-secure.bat` - Startup script
✅ `packages/mcp-bucontrol-server/SECURITY.md` - Complete security guide

## Quick Reference

| Endpoint | Auth Required | Purpose |
|----------|---------------|---------|
| `/health` | ❌ No | Server status check |
| `/sse` | ✅ Yes | MCP server connection |
| `/message` | ✅ Yes | MCP message handler |
| `/authorize` | ✅ Yes | OAuth authorization |
| `/token` | ✅ Yes | OAuth token exchange |

## Next Steps

1. **Review Configuration**
   - Check `.env` file settings
   - Verify `BIND_ADDRESS` is correct

2. **Start Server**
   ```batch
   cd packages\mcp-bucontrol-server
   start-secure.bat
   ```

3. **Test Locally**
   ```bash
   curl http://100.71.254.15:3100/health
   ```

4. **Install Tailscale on iPad**
   - Download from App Store
   - Sign in and connect

5. **Test from iPad**
   - Safari → `http://100.71.254.15:3100/health`

6. **Configure MCP Client**
   - Use URL: `http://100.71.254.15:3100/sse`
   - Add API key header

## Troubleshooting

See [SECURITY.md](SECURITY.md) for complete troubleshooting guide.

### Common Issues

**"Connection Refused"**
- Check server is running: `netstat -ano | findstr 3100`
- Verify `BIND_ADDRESS` in .env

**"Unauthorized"**
- Check API key is correct
- Use `x-api-key` header (lowercase)
- Verify no extra spaces in key

**"CORS Error"**
- Add origin to `ALLOWED_ORIGINS` in .env
- Restart server after changes

## Security Checklist

Before exposing to network:

- [x] API keys configured
- [x] BIND_ADDRESS set to VPN IP
- [x] CORS origins configured
- [x] Rate limiting enabled
- [x] Audit logging enabled
- [x] Input validation enabled
- [x] .env file not in git
- [x] SSL certificates present
- [ ] Tested from remote device
- [ ] Monitoring audit logs

## Support

- **Security Guide:** [SECURITY.md](SECURITY.md)
- **Environment Template:** [.env.example](.env.example)
- **Startup Script:** [start-secure.bat](start-secure.bat)

---

**Status:** ✅ SECURE - Ready to expose on VPN
**Last Updated:** 2025-11-18
**Server Version:** 1.0.0
