# ElevenLabs & Cloud Platform Setup - Complete Guide

## ✅ Setup Complete!

Your MCP BUControl server is now publicly accessible and ready for ElevenLabs integration.

---

## 🌐 Public URL

**Your Server URL:** `https://cold-chicken-allow.loca.lt`

**Health Check:** https://cold-chicken-allow.loca.lt/health
**MCP Endpoint:** https://cold-chicken-allow.loca.lt/sse

---

## 🔑 Authentication

**API Key:** `Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=`

**Required Headers:**
```
x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=
bypass-tunnel-reminder: true
```

---

## 📋 ElevenLabs Configuration

### For MCP Integration

```json
{
  "mcpServers": {
    "bucontrol": {
      "url": "https://cold-chicken-allow.loca.lt/sse",
      "headers": {
        "x-api-key": "Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=",
        "bypass-tunnel-reminder": "true"
      }
    }
  }
}
```

### For REST API

```javascript
// JavaScript/Node.js
const response = await fetch('https://cold-chicken-allow.loca.lt/sse', {
  headers: {
    'x-api-key': 'Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=',
    'bypass-tunnel-reminder': 'true'
  }
});
```

```python
# Python
import requests

response = requests.get(
    'https://cold-chicken-allow.loca.lt/sse',
    headers={
        'x-api-key': 'Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=',
        'bypass-tunnel-reminder': 'true'
    }
)
```

```bash
# cURL
curl -H "x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=" \
     -H "bypass-tunnel-reminder: true" \
     https://cold-chicken-allow.loca.lt/sse
```

---

## 🧪 Test Your Connection

### 1. Health Check (No Auth Required)

```bash
curl -H "bypass-tunnel-reminder: true" \
     https://cold-chicken-allow.loca.lt/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "websocket": "connected",
  "identified": true,
  "components": ["videoWall", "hdmiDisplay", "gpio", "hdmiDecoder", "lighting", "mixer"]
}
```

### 2. Authenticated MCP Endpoint

```bash
curl -H "x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=" \
     -H "bypass-tunnel-reminder: true" \
     https://cold-chicken-allow.loca.lt/sse
```

**Expected:** Server-Sent Events stream starts (connection stays open)

---

##⚙️ Current Setup Details

### Server Status
- ✅ MCP Server: **RUNNING**
- ✅ Public Tunnel: **ACTIVE** (localtunnel)
- ✅ Authentication: **ENABLED**
- ✅ Rate Limiting: **100 requests/minute**
- ✅ Audit Logging: **ENABLED**

### Network Configuration
- **Binding:** `0.0.0.0:3100` (all interfaces - for tunnel compatibility)
- **Public URL:** `https://cold-chicken-allow.loca.lt`
- **Tunnel Type:** localtunnel
- **SSL:** HTTPS (provided by localtunnel)

### Security Features
- ✅ API Key authentication
- ✅ Rate limiting (100 req/min)
- ✅ CORS protection
- ✅ Input validation
- ✅ Audit logging
- ✅ WindowCommand format validation

---

## 🔄 Server Management

### Check Status

```bash
# Check if server is running
netstat -ano | findstr "3100"

# Should see:
# TCP    0.0.0.0:3100    ... LISTENING
```

### View Logs

```bash
# Server logs
tail -f packages/mcp-bucontrol-server/server2.log

# Localtunnel output
tail -f tools/lt-final.txt

# Audit log (security events)
tail -f packages/mcp-bucontrol-server/audit.log
```

### Restart Tunnel

If the tunnel URL changes or disconnects:

```bash
# Stop localtunnel
pkill -f localtunnel

# Restart
npx localtunnel --port 3100

# Get new URL from output
```

---

## ⚠️ Important Notes

### 1. Tunnel URL Changes

**The public URL (`https://cold-chicken-allow.loca.lt`) will change if:**
- You restart the localtunnel process
- The tunnel connection drops
- You restart your computer

**To get a permanent URL:**
- Upgrade to ngrok paid ($10/mo) for static subdomain
- Use Cloudflare Tunnel (free, permanent)
- See [EXPOSE_TO_CLOUD.md](EXPOSE_TO_CLOUD.md) for details

### 2. Required Headers

**ALWAYS include these headers:**
```
x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=
bypass-tunnel-reminder: true
```

The `bypass-tunnel-reminder` header prevents localtunnel's landing page from showing.

### 3. Localtunnel Landing Page

If you access the URL in a browser without the bypass header, you'll see a landing page asking for a "tunnel password". This is normal behavior for localtunnel.

**To bypass:**
- Add `bypass-tunnel-reminder: true` header (recommended)
- Or use custom User-Agent header
- Or visit once from your public IP to set cookie

### 4. Security

- ✅ Server exposed to internet with security
- ✅ API key required for all control endpoints
- ✅ Health check endpoint is public (read-only)
- ✅ All actions logged to audit.log
- ⚠️ Server bound to 0.0.0.0 for tunnel compatibility

---

## 🎯 Available MCP Tools

Once connected, ElevenLabs can use these tools:

### Video Wall Control
- `send_videowall_command` - Send WindowCommand to control video wall
- `get_videowall_status` - Get current video wall state
- `list_video_sources` - List available video inputs

### Display Control
- `set_screen_power` - Turn screen on/off
- `get_screen_power` - Get screen power state

### Privacy Glass
- `set_privacy_glass` - Frost/clear privacy glass
- `get_privacy_glass` - Get privacy glass state

### Video Routing
- `set_dido_output` - Enable/disable DIDO output
- `get_dido_output` - Get DIDO output state

### Lighting
- `set_lighting_level` - Set lighting (0-100)
- `get_lighting_level` - Get current lighting level

### Audio
- `set_volume` - Set volume (-100 to +10 dB)
- `get_volume` - Get current volume level

---

## 🚨 Troubleshooting

### "Connection Refused"

**Check server is running:**
```bash
netstat -ano | findstr "3100"
```

**Check localtunnel is running:**
```bash
ps aux | grep localtunnel  # Linux/Mac
tasklist | findstr "node"  # Windows
```

### "Unauthorized" Error

**Verify headers are set:**
- `x-api-key` must match exactly (no spaces)
- Header name is lowercase: `x-api-key`

### "503 - Tunnel Unavailable"

**Restart localtunnel:**
```bash
pkill -f localtunnel
npx localtunnel --port 3100
```

**Verify server is listening:**
```bash
curl http://localhost:3100/health
```

### Tunnel URL Changed

If your URL changed:
1. Check `tools/lt-final.txt` for new URL
2. Update your ElevenLabs configuration
3. Consider using permanent URL solution (see below)

---

## 🎁 Upgrade Options

### For Permanent URL

**Option 1: ngrok Paid ($10/month)**
```bash
# Install ngrok
choco install ngrok

# Authenticate
ngrok config add-authtoken YOUR_TOKEN

# Start with custom subdomain
ngrok http 3100 --subdomain=bucontrol

# URL: https://bucontrol.ngrok.io (permanent)
```

**Option 2: Cloudflare Tunnel (FREE)**
```bash
# Install cloudflared
# Download from: https://developers.cloudflare.com/cloudflare-one/

# Create tunnel
cloudflared tunnel create bucontrol-mcp

# Configure and run
# See: EXPOSE_TO_CLOUD.md for complete setup
```

---

## 📊 Monitor Usage

### View Audit Log

```bash
# Real-time monitoring
tail -f packages/mcp-bucontrol-server/audit.log

# Filter for specific actions
grep "send_videowall_command" audit.log
grep "auth_invalid" audit.log
grep "rate_limit_exceeded" audit.log
```

### Check Failed Authentication

```bash
# Windows
findstr "auth_invalid" packages\mcp-bucontrol-server\audit.log

# Linux/Mac
grep "auth_invalid" packages/mcp-bucontrol-server/audit.log
```

---

## 📞 Quick Reference

| Item | Value |
|------|-------|
| **Public URL** | https://cold-chicken-allow.loca.lt |
| **Health Endpoint** | /health |
| **MCP Endpoint** | /sse |
| **API Key** | Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI= |
| **Bypass Header** | bypass-tunnel-reminder: true |
| **Rate Limit** | 100 requests/minute |
| **SSL** | HTTPS (via localtunnel) |

---

## 🎬 Getting Started with ElevenLabs

1. **Copy this configuration:**
   ```json
   {
     "url": "https://cold-chicken-allow.loca.lt/sse",
     "headers": {
       "x-api-key": "Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=",
       "bypass-tunnel-reminder": "true"
     }
   }
   ```

2. **Test connection first:**
   ```bash
   curl -H "bypass-tunnel-reminder: true" \
        -H "x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=" \
        https://cold-chicken-allow.loca.lt/health
   ```

3. **Configure in ElevenLabs**
   - Use the URL and headers above
   - Test with a simple command

4. **Monitor logs**
   - Watch `audit.log` for activity
   - Check for errors or failed auth

---

**Everything is ready!** Your server is publicly accessible with full security at:
**https://cold-chicken-allow.loca.lt**

Keep the server and localtunnel running for continuous access.
