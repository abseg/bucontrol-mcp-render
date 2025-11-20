# Adding MCP BUControl Server to Claude Desktop

## 📋 Quick Setup

### Step 1: Locate Claude Desktop Config File

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

**Full path:**
```
C:\Users\YOUR_USERNAME\AppData\Roaming\Claude\claude_desktop_config.json
```

**Mac:**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Linux:**
```
~/.config/Claude/claude_desktop_config.json
```

---

### Step 2: Open Configuration File

**Windows (PowerShell):**
```powershell
notepad $env:APPDATA\Claude\claude_desktop_config.json
```

**Or navigate manually:**
1. Press `Win + R`
2. Type: `%APPDATA%\Claude`
3. Open `claude_desktop_config.json` in Notepad

---

### Step 3: Add MCP Server Configuration

**If file is empty or new:**
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

**If you already have other MCP servers:**
```json
{
  "mcpServers": {
    "existing-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    },
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

---

### Step 4: Restart Claude Desktop

1. **Completely quit** Claude Desktop (right-click system tray icon → Quit)
2. **Reopen** Claude Desktop
3. The MCP server will connect automatically

---

## ✅ Verification

### Check Connection in Claude Desktop

1. Open a new conversation in Claude Desktop
2. Look for **MCP tools indicator** (usually a small icon or message)
3. You should see **bucontrol** listed as an available server
4. Available tools will include:
   - `send_videowall_command`
   - `get_videowall_status`
   - `list_video_sources`
   - `set_screen_power`
   - `set_privacy_glass`
   - `set_lighting_level`
   - `set_volume`
   - And more...

### Test It

Try asking Claude:
```
"Can you check the video wall status?"
```

Or:
```
"Set the lighting to 50%"
```

Claude should be able to use the MCP tools to control your video wall!

---

## 🔧 Alternative: Local Server (More Stable)

If you want to use the local MCP server instead of the public URL:

### Option 1: Stdio Transport (Local)

**Edit your config to use the local server:**

```json
{
  "mcpServers": {
    "bucontrol": {
      "command": "node",
      "args": ["C:\\BUControl\\bucontrol\\packages\\mcp-bucontrol-server\\index.js"]
    }
  }
}
```

This connects directly via stdio (no network, no auth needed).

### Option 2: SSE Transport (Network - VPN)

**If on same machine or Tailscale VPN:**

```json
{
  "mcpServers": {
    "bucontrol": {
      "url": "http://100.71.254.15:3100/sse",
      "headers": {
        "x-api-key": "Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI="
      }
    }
  }
}
```

---

## 📊 Comparison

| Method | Pros | Cons | Use Case |
|--------|------|------|----------|
| **Public URL (localtunnel)** | Access from anywhere | URL changes on restart | Testing, remote access |
| **Stdio (local)** | Fast, no network needed | Same machine only | Local use, most stable |
| **VPN (Tailscale)** | Secure remote access | Requires VPN setup | Secure remote use |

---

## 🚨 Troubleshooting

### Claude Desktop doesn't show MCP server

**Check:**
1. Configuration file syntax is valid JSON (use jsonlint.com)
2. No trailing commas in JSON
3. Quotes are correct (double quotes, not single)
4. File saved properly
5. Claude Desktop fully restarted

### "Connection failed" error

**If using public URL:**
- Check server is running: `netstat -ano | findstr 3100`
- Check localtunnel is active: `ps aux | grep localtunnel`
- Verify URL hasn't changed: `cat tools/lt-final.txt`

**If using local stdio:**
- Check path to `index.js` is correct
- Use full absolute path (not relative)

### Tools not appearing

**Check:**
1. Server connected successfully (check Claude Desktop logs)
2. API key is correct (if using network transport)
3. Headers are properly formatted

### View Claude Desktop Logs

**Windows:**
```
%APPDATA%\Claude\logs
```

**Mac:**
```
~/Library/Logs/Claude
```

Look for MCP connection errors.

---

## 🎯 Recommended Configuration

### For Same Machine (Easiest & Most Stable)

```json
{
  "mcpServers": {
    "bucontrol": {
      "command": "node",
      "args": ["C:\\BUControl\\bucontrol\\packages\\mcp-bucontrol-server\\index.js"]
    }
  }
}
```

**Why:**
- No network configuration needed
- No authentication needed
- Fast and reliable
- Won't break if URL changes

### For Remote Access (Most Flexible)

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

**Why:**
- Works from anywhere
- Access from different devices
- Good for testing

---

## 📝 Example Complete Config

Here's a complete example with both local and remote options:

```json
{
  "mcpServers": {
    "bucontrol-local": {
      "command": "node",
      "args": ["C:\\BUControl\\bucontrol\\packages\\mcp-bucontrol-server\\index.js"]
    },
    "bucontrol-remote": {
      "url": "https://cold-chicken-allow.loca.lt/sse",
      "headers": {
        "x-api-key": "Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=",
        "bypass-tunnel-reminder": "true"
      }
    }
  }
}
```

You can have both configured and Claude will connect to both!

---

## 🎮 Using the Tools in Claude Desktop

Once connected, you can ask Claude things like:

**Video Wall Control:**
- "Show camera 1 fullscreen on the video wall"
- "Create a split screen with camera 2 on left and camera 3 on right"
- "Make a picture-in-picture with camera 1 as background and camera 4 in the corner"

**Environment Control:**
- "Set the lighting to 75%"
- "Turn the privacy glass on"
- "Set volume to -20 dB"
- "Turn the screen off"

**Status Queries:**
- "What's the current video wall status?"
- "Which video sources are connected?"
- "What's the current lighting level?"

Claude will automatically use the MCP tools to execute these commands!

---

## 🔄 Update URL When It Changes

If your localtunnel URL changes (on restart):

1. Get new URL: `cat tools/lt-final.txt`
2. Edit config file: `notepad %APPDATA%\Claude\claude_desktop_config.json`
3. Update the URL in the configuration
4. Restart Claude Desktop

**Better solution:** Use the local stdio transport for stability!

---

## ✅ Quick Setup Checklist

- [ ] MCP server running (`netstat -ano | findstr 3100`)
- [ ] Localtunnel active (if using remote URL)
- [ ] Configuration file edited
- [ ] Valid JSON syntax
- [ ] Claude Desktop restarted
- [ ] Tools visible in Claude Desktop
- [ ] Test command successful

---

## 📞 Need Help?

- **Config file location issues:** Check your Windows username in path
- **JSON syntax errors:** Use https://jsonlint.com to validate
- **Connection failures:** Check [STATUS_REPORT.md](STATUS_REPORT.md) for server status
- **Tool issues:** See [ELEVENLABS_SETUP.md](ELEVENLABS_SETUP.md) for troubleshooting

---

**You're all set! Claude Desktop can now control your BUControl Video Wall! 🎉**
