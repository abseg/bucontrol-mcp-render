# Exposing MCP Server to Cloud Platforms (ElevenLabs, etc.)

For platforms like ElevenLabs where you can't install Tailscale, you need to expose your server to the internet securely.

---

## ⭐ Option 1: Cloudflare Tunnel (Recommended)

**Pros:** Free, secure, no port forwarding, HTTPS included
**Cons:** Requires Cloudflare account

### Setup (5 minutes):

1. **Install Cloudflare Tunnel (cloudflared)**

   Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

   Or via Chocolatey:
   ```powershell
   choco install cloudflared
   ```

2. **Login to Cloudflare**
   ```bash
   cloudflared tunnel login
   ```

3. **Create Tunnel**
   ```bash
   cloudflared tunnel create bucontrol-mcp
   ```

4. **Configure Tunnel**

   Create `C:\Users\YOUR_USER\.cloudflared\config.yml`:
   ```yaml
   tunnel: YOUR_TUNNEL_ID
   credentials-file: C:\Users\YOUR_USER\.cloudflared\YOUR_TUNNEL_ID.json

   ingress:
     - hostname: bucontrol-mcp.yourdomain.com
       service: http://100.71.254.15:3100
     - service: http_status:404
   ```

5. **Route DNS**
   ```bash
   cloudflared tunnel route dns bucontrol-mcp bucontrol-mcp.yourdomain.com
   ```

6. **Run Tunnel**
   ```bash
   cloudflared tunnel run bucontrol-mcp
   ```

7. **Your public URL:**
   ```
   https://bucontrol-mcp.yourdomain.com/health
   ```

8. **ElevenLabs Config:**
   ```json
   {
     "url": "https://bucontrol-mcp.yourdomain.com/sse",
     "headers": {
       "x-api-key": "Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI="
     }
   }
   ```

---

## 🚀 Option 2: ngrok (Easiest - Quick Test)

**Pros:** Super easy, works instantly
**Cons:** Free tier has random URLs, paid for static URLs

### Setup (2 minutes):

1. **Install ngrok**

   Download: https://ngrok.com/download

   Or via Chocolatey:
   ```powershell
   choco install ngrok
   ```

2. **Sign up** at https://ngrok.com (free account)

3. **Authenticate**
   ```bash
   ngrok config add-authtoken YOUR_AUTH_TOKEN
   ```

4. **Start Tunnel**
   ```bash
   ngrok http 100.71.254.15:3100
   ```

5. **You'll get a URL like:**
   ```
   https://abc123.ngrok.io
   ```

6. **Test it:**
   ```bash
   curl https://abc123.ngrok.io/health
   ```

7. **ElevenLabs Config:**
   ```json
   {
     "url": "https://abc123.ngrok.io/sse",
     "headers": {
       "x-api-key": "Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI="
     }
   }
   ```

**⚠️ Note:** Free ngrok URLs change each restart. Upgrade for static URLs.

---

## 🔓 Option 3: Direct Internet Exposure (Not Recommended)

Only if you understand the risks and have strong security.

### Setup:

1. **Change Binding to All Interfaces**

   Edit `.env`:
   ```env
   BIND_ADDRESS=0.0.0.0
   ```

2. **Configure Router Port Forwarding**

   Forward external port to:
   - Internal IP: `192.168.100.53`
   - Internal Port: `3100`

3. **Get Your Public IP**
   ```bash
   curl ifconfig.me
   ```

4. **Use Dynamic DNS (if IP changes)**
   - Sign up: No-IP, DuckDNS, or Dynu
   - Install client to update IP automatically

5. **ElevenLabs Config:**
   ```json
   {
     "url": "http://YOUR_PUBLIC_IP:3100/sse",
     "headers": {
       "x-api-key": "Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI="
     }
   }
   ```

**⚠️ SECURITY WARNINGS:**
- Exposed to entire internet
- Configure firewall rules
- Use HTTPS (SSL certificates required)
- Monitor audit.log constantly
- Consider IP whitelist

---

## 📋 Quick Comparison

| Method | Security | Cost | Setup | URL Stability |
|--------|----------|------|-------|---------------|
| **Cloudflare Tunnel** | ⭐⭐⭐⭐⭐ | Free | Medium | Permanent |
| **ngrok Free** | ⭐⭐⭐⭐ | Free | Easy | Changes on restart |
| **ngrok Paid** | ⭐⭐⭐⭐ | $10/mo | Easy | Permanent |
| **Direct Exposure** | ⭐⭐ | Free | Hard | Depends on ISP |

---

## 🎯 Recommended for ElevenLabs

**For testing (quick & dirty):**
```bash
# Install ngrok
choco install ngrok

# Start tunnel
ngrok http 100.71.254.15:3100

# Use the https://xxx.ngrok.io URL in ElevenLabs
```

**For production (secure & reliable):**
Use **Cloudflare Tunnel** - it's free, secure, and gives you a permanent HTTPS URL.

---

## 🔐 Additional Security for Internet Exposure

When exposing to internet, enhance security:

### 1. IP Whitelist (Optional)

Add to `server.js` before API key check:

```javascript
const ALLOWED_IPS = [
  '34.120.127.130',  // Example: ElevenLabs IP range
  '35.201.89.0/24'   // CIDR notation supported
];

app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const clientIP = req.ip.replace('::ffff:', '');
  const allowed = ALLOWED_IPS.some(range => {
    if (range.includes('/')) {
      // CIDR check logic here
      return false; // Implement if needed
    }
    return clientIP === range;
  });

  if (!allowed) {
    auditLog('ip_blocked', null, { ip: clientIP });
    return res.status(403).json({ error: 'IP not allowed' });
  }

  next();
});
```

### 2. Stronger Rate Limiting

Edit `.env`:
```env
RATE_LIMIT_MAX_REQUESTS=20  # Reduce from 100
RATE_LIMIT_WINDOW_MS=60000  # 1 minute
```

### 3. Enable HTTPS Only

Generate SSL certificate (self-signed for testing):
```bash
openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.cert -days 365 -nodes
```

Or use Let's Encrypt for proper SSL.

---

## 📝 Step-by-Step: ngrok Quick Setup

**Most straightforward for immediate testing:**

1. **Download ngrok:**
   ```
   https://ngrok.com/download
   ```

2. **Extract and run:**
   ```bash
   cd Downloads
   ngrok http 100.71.254.15:3100
   ```

3. **You'll see:**
   ```
   Session Status                online
   Forwarding                    https://abc123.ngrok.io -> http://100.71.254.15:3100
   ```

4. **Test in browser:**
   ```
   https://abc123.ngrok.io/health
   ```

5. **Use in ElevenLabs:**
   - URL: `https://abc123.ngrok.io/sse`
   - Header: `x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=`

6. **Keep ngrok running** while testing

---

## 🛠️ Automation Scripts

### Auto-start with ngrok

Save as `start-with-ngrok.bat`:

```batch
@echo off
echo Starting MCP Server with ngrok tunnel...

REM Start MCP server in background
start /B cmd /c "cd packages\mcp-bucontrol-server && npm run start:remote"

REM Wait for server to start
timeout /t 5

REM Start ngrok tunnel
ngrok http 100.71.254.15:3100
```

### Auto-start with Cloudflare Tunnel

Save as `start-with-cloudflare.bat`:

```batch
@echo off
echo Starting MCP Server with Cloudflare Tunnel...

REM Start MCP server in background
start /B cmd /c "cd packages\mcp-bucontrol-server && npm run start:remote"

REM Wait for server to start
timeout /t 5

REM Start Cloudflare tunnel
cloudflared tunnel run bucontrol-mcp
```

---

## 🔍 Testing Your Public URL

Once exposed, test from anywhere:

```bash
# From any computer on internet (not your network)
curl https://your-public-url.com/health

# Should see:
{
  "status": "ok",
  "websocket": "connected",
  ...
}
```

---

## ⚠️ Important Notes

1. **Server must be running** before starting tunnel
2. **Keep tunnel running** while ElevenLabs needs access
3. **Monitor audit.log** for unauthorized access attempts
4. **Free ngrok URLs expire** - paid plan for permanent URLs
5. **Cloudflare Tunnel is better** for production use

---

## 🆘 Troubleshooting

**ngrok says "command not found":**
- Add ngrok to PATH
- Or run from ngrok directory
- Or use full path: `C:\path\to\ngrok.exe http 3100`

**Cloudflare Tunnel connection failed:**
- Check firewall allows outbound connections
- Verify credentials file path
- Check tunnel name matches config

**"404 tunneling error" on ngrok:**
- Make sure MCP server is running first
- Check binding address in .env
- Verify port 3100 is correct

**ElevenLabs can't connect:**
- Check URL is correct (including /sse path)
- Verify API key header is set
- Test URL in browser first
- Check CORS settings in .env

---

**Need more help?** See [SECURITY.md](SECURITY.md) for security details.
