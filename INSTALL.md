# Quick Installation Guide

## 1. Install Dependencies

```bash
cd mcp-bucontrol-server
npm install
```

## 2. Configure Your VPN/Network

Edit the `CONFIG` object in both `index.js` and `server.js`:

```javascript
const CONFIG = {
  controllerId: 'modular-controller-config',
  websocketPort: 3004, // Your WebSocket port
  hostname: '100.71.254.15' // Your VPN/server IP
};
```

## 3. For Claude Desktop (Local)

Add to your `claude_desktop_config.json`:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bucontrol": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-bucontrol-server/index.js"
      ]
    }
  }
}
```

Restart Claude Desktop.

## 4. For Remote Access (iPad, other devices)

### Generate SSL Certificate

**IMPORTANT:** The certificate CN (Common Name) **MUST** match the hostname you configured in step 2!

```bash
# Windows (PowerShell) - Replace 100.71.254.15 with your VPN/server IP
powershell -Command "openssl req -nodes -new -x509 -keyout server.key -out server.cert -days 365 -subj '/C=US/ST=State/L=City/O=BUControl/CN=100.71.254.15'"

# macOS/Linux - Replace 100.71.254.15 with your VPN/server IP
openssl req -nodes -new -x509 -keyout server.key -out server.cert -days 365 -subj '/C=US/ST=State/L=City/O=BUControl/CN=100.71.254.15'

# For local testing only (use localhost)
openssl req -nodes -new -x509 -keyout server.key -out server.cert -days 365 -subj '/C=US/ST=State/L=City/O=BUControl/CN=localhost'
```

### Start Remote Server

```bash
npm run start:remote
```

Note the HTTPS URL shown in the output (e.g., `https://192.168.1.100:3100/sse`)

### Connect from iPad/Phone

1. Open Claude app/browser
2. Add MCP server with the URL: `https://YOUR-IP:3100/sse`
3. Accept the self-signed certificate warning

## 5. Test It!

Ask Claude:
- "What's currently displayed on the video wall?"
- "Show input 1 full screen"
- "Set the lights to 50%"
- "What's the current volume level?"

## Troubleshooting

**Can't connect?**
- Verify Node-RED WebSocket bridge is running
- Check the IP address and port in CONFIG
- Verify firewall allows port 3004 (WebSocket) and 3100 (HTTPS)

**Certificate errors?**
- Make sure to accept the self-signed certificate warning
- For production, use a real SSL certificate

**Commands not working?**
- Check Claude Desktop logs (see README.md for log locations)
- Verify all components are discovered in the logs
