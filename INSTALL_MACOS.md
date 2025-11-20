# BUControl MCP Server - macOS Installation Guide

Complete guide for using BUControl MCP Server from Claude Desktop on macOS.

## Architecture

- **Windows Machine** (100.71.254.15): Runs MCP server + WebSocket bridge + Q-SYS
- **macOS Machine** (your laptop): Runs Claude Desktop, connects remotely via HTTPS

---

## Prerequisites on Windows Machine

✅ Node.js 18+ installed
✅ WebSocket bridge running (port 3004)
✅ Package installed at: `C:\BUControl\bucontrol\packages\mcp-bucontrol-server\`

---

## Step 1: Start the MCP Server (Windows Machine)

On the Windows machine, open Command Prompt:

```cmd
cd C:\BUControl\bucontrol\packages\mcp-bucontrol-server
npm install
npm run start:remote
```

**Expected output:**
```
[MCP] BUControl MCP Server (Remote Access) starting...
[MCP] Connecting to http://100.71.254.15:3004...
[MCP] Connected to WebSocket bridge
[MCP] Client identified: mcp-sse-xxxxx
[MCP] Discovering 44 components...
[MCP] Found video wall: BUControl_VideoWall_Controller (id)
[MCP] HTTP server listening on http://100.71.254.15:3100
[MCP] HTTPS server listening on https://100.71.254.15:3443
```

✅ **Verify it's running:**
- HTTPS URL: `https://100.71.254.15:3443/sse`
- Server stays running (doesn't exit)

**Leave this window open** - server must keep running.

---

## Step 2: Configure Claude Desktop (macOS)

On your Mac, edit the Claude Desktop config file:

```bash
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Add this configuration:**
```json
{
  "mcpServers": {
    "bucontrol": {
      "url": "https://100.71.254.15:3443/sse"
    }
  }
}
```

⚠️ **IMPORTANT:**
- Use `https://` (not `http://`)
- Use port `3443` (HTTPS port, not 3100)
- IP must match your Windows machine's Tailscale/VPN address

**Save and exit** (Ctrl+O, Enter, Ctrl+X in nano)

---

## Step 3: Restart Claude Desktop

1. **Quit Claude Desktop completely:**
   - Cmd+Q or Claude menu → Quit

2. **Wait 5 seconds**

3. **Open Claude Desktop**

4. **Check logs** (if needed):
   ```bash
   tail -f ~/Library/Logs/Claude/mcp*.log
   ```

---

## Step 4: Test the Connection

In Claude Desktop, ask:

```
What tools do you have available?
```

**Should see these tools:**
- `send_videowall_command`
- `get_videowall_status`
- `list_video_sources`
- `set_screen_power` / `get_screen_power`
- `set_lighting_level` / `get_lighting_level`
- `set_volume` / `get_volume`
- And more...

**Test a command:**
```
What's the current lighting level?
```

**Expected response:**
```json
{
  "status": "success",
  "level": 100
}
```

---

## Troubleshooting

### Problem: Connection refused / timeout

**Check on Windows machine:**
1. ✅ MCP server is running (`npm run start:remote`)
2. ✅ You see `HTTPS server listening on https://100.71.254.15:3443`
3. ✅ Firewall allows port 3443
4. ✅ WebSocket bridge is connected

**Check on Mac:**
1. ✅ Tailscale/VPN is connected
2. ✅ Can ping Windows machine: `ping 100.71.254.15`
3. ✅ Config uses `https://` (not `http://`)
4. ✅ Config uses port `3443` (not `3100`)

**Test connection from Mac:**
```bash
curl -k -v https://100.71.254.15:3443/sse
```

Should connect (not connection refused).

---

### Problem: Certificate errors

The Windows machine uses self-signed certificates. Claude Desktop should accept them automatically.

**If you see certificate errors:**

1. **Check certificate CN matches hostname**

   On Windows machine:
   ```cmd
   openssl x509 -in server.cert -noout -subject
   ```

   Should show: `CN=100.71.254.15`

2. **Regenerate certificate if needed:**
   ```cmd
   cd C:\BUControl\bucontrol\packages\mcp-bucontrol-server
   del server.key server.cert
   openssl req -nodes -new -x509 -keyout server.key -out server.cert -days 365 -subj "/C=US/ST=State/L=City/O=BUControl/CN=100.71.254.15"
   ```

3. **Restart MCP server** on Windows

---

### Problem: Tools show "unknown" status

**This means:**
- Connection established ✅
- But component states not received

**Check on Windows machine:**
1. ✅ WebSocket bridge running (port 3004)
2. ✅ Q-SYS Core online
3. ✅ Server logs show: `Found video wall`, `Found lighting`, etc.
4. ✅ Server logs show: `Subscribed to component: ...`

**If components not found:**
- Check `CONFIG.controllerId` in `server.js`
- Must match your Q-SYS controller ID

---

## Running as Background Service (Windows)

To keep the MCP server running without a terminal window:

### Option 1: Using pm2

On Windows machine:

```cmd
npm install -g pm2
cd C:\BUControl\bucontrol\packages\mcp-bucontrol-server
pm2 start server.js --name bucontrol-mcp
pm2 save
pm2 startup
```

**Check status:**
```cmd
pm2 status
pm2 logs bucontrol-mcp
```

**Stop server:**
```cmd
pm2 stop bucontrol-mcp
```

---

## Multiple Mac Setup

If multiple people need access from their Macs, they all use the same config:

```json
{
  "mcpServers": {
    "bucontrol": {
      "url": "https://100.71.254.15:3443/sse"
    }
  }
}
```

**Requirements:**
- All Macs on same VPN/network
- All can reach `100.71.254.15:3443`
- Windows MCP server keeps running

---

## Security Notes

⚠️ **Self-signed certificates:** Normal security warnings - safe to ignore on trusted network

⚠️ **Network access:** Only use on trusted VPN/LAN (Tailscale recommended)

⚠️ **Full control:** MCP server has complete control over Q-SYS - protect access

---

## Testing Commands

Try these in Claude Desktop:

**Status:**
```
What's currently on the video wall?
What's the lighting level?
List video sources
```

**Control:**
```
Show input 1 full screen
Set lights to 50%
Set volume to -20dB
```

---

## Summary Checklist

**On Windows machine:**
- [ ] MCP server running (`npm run start:remote`)
- [ ] See `HTTPS server listening on https://100.71.254.15:3443`
- [ ] WebSocket connected (see logs)
- [ ] Firewall allows port 3443
- [ ] Components discovered (see logs)

**On Mac:**
- [ ] Tailscale/VPN connected
- [ ] Can ping `100.71.254.15`
- [ ] Config file: `~/Library/Application Support/Claude/claude_desktop_config.json`
- [ ] Config uses `https://100.71.254.15:3443/sse`
- [ ] Claude Desktop fully restarted
- [ ] Asked "What tools do you have?"

✅ **All checked?** Should be working!

---

## Quick Reference

**Config file location (Mac):**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Log file location (Mac):**
```
~/Library/Logs/Claude/mcp*.log
```

**Server URL:**
```
https://100.71.254.15:3443/sse
```

**Test connection:**
```bash
curl -k -v https://100.71.254.15:3443/sse
```

**Check if server running (Windows):**
```cmd
netstat -ano | findstr 3443
```
