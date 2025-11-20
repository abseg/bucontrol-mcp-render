# BUControl MCP Server

Model Context Protocol (MCP) server that enables Claude Desktop to control the entire BUControl room system via natural language commands.

## Overview

This MCP server acts as a thin WebSocket wrapper around the BUControl system. Claude Desktop generates WindowCommand strings and control values directly - the server simply handles the WebSocket communication with the Node-RED bridge.

### Features

- **Natural Language Control**: Ask Claude to control your entire room in plain English
- **Video Wall Control**: Advanced multi-window display configurations with overlays and transparency
- **Room Controls**: Lights, volume, screen power, privacy glass, and DIDO output selection
- **Real-time Status**: Query current state of all devices and configurations
- **Simple Integration**: Claude generates commands, server handles communication
- **Stateful Connection**: Maintains persistent WebSocket connection for low latency

## Installation

### Prerequisites

- Node.js 18.0.0 or higher
- BUControl system running (Node-RED + WebSocket bridge)
- Claude Desktop application

### Setup

1. **Install dependencies:**

```bash
cd packages/mcp-bucontrol-server
npm install
```

2. **Configure Claude Desktop:**

Edit your Claude Desktop MCP configuration file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`

Add the BUControl server:

```json
{
  "mcpServers": {
    "bucontrol": {
      "command": "node",
      "args": [
        "c:\\BUControl\\bucontrol\\packages\\mcp-bucontrol-server\\index.js"
      ]
    }
  }
}
```

**Note:** Use absolute paths. On Windows, escape backslashes or use forward slashes.

3. **Restart Claude Desktop**

The MCP server will automatically:
- Fetch the WebSocket port from the Config API
- Connect to the WebSocket bridge
- Identify as a client
- Discover the BUControl Video Wall Controller component
- Subscribe to state updates

### Remote Access (iPad, iPhone, other devices on LAN)

To use from an iPad or other device on your local network:

1. **Start the remote server:**

```bash
cd packages/mcp-bucontrol-server
npm run start:remote
```

2. **Note the network address** shown in the output:
```
[MCP] Network: http://192.168.1.100:3100
From your iPad, use: http://192.168.1.100:3100/sse
```

3. **On your iPad** (using Claude.ai in browser or Claude app):
   - The app should auto-detect MCP servers on your network
   - Or manually add the server URL: `http://YOUR-IP:3100/sse`

4. **That's it!** You can now control your room from your iPad using natural language.

## Usage

### Example Commands

Once configured, you can ask Claude naturally:

**Video Wall Commands:**
- "Show input 1 full screen on the video wall"
- "Display input 2 and input 3 side by side"
- "Put input 1 full screen with input 3 in the bottom right corner"
- "Show input 1 full screen with an overlay of input 3 at 60% opacity"
- "Display input 2 full screen with a small PIP of input 4 in the top right corner at 25% size"

**Room Control Commands:**
- "Turn on the screen"
- "Turn off the screen"
- "Dim the lights to 40%"
- "Set the lights to full brightness"
- "Turn the lights off"
- "Frost the privacy glass"
- "Clear the privacy glass"
- "Enable the DIDO output so I can see the video wall"
- "Set the volume to 0 dB"
- "Lower the volume to -20 dB"
- "Mute the audio" (sets to -100 dB)
- "Increase volume to -10 dB"

**Combined Commands:**
- "Dim the board room lights and pull input1 full screen on the video wall with an overlay of input 3 full screen as well but with opacity 60"
- "Turn on the screen, set lights to 75%, set volume to -10 dB, clear the privacy glass, and show input 2 full screen"
- "Prepare the room for a presentation: lights at 50%, screen on, privacy glass clear, volume at 0 dB, show input 1"
- "Set up for movie mode: lights at 20%, volume at -5 dB, frost the privacy glass, show input 1 full screen"

**Status Queries:**
- "What's currently displayed on the video wall?"
- "Which video sources are connected?"
- "What's the current lighting level?"
- "What's the current volume level?"
- "Is the screen on?"
- "Is the privacy glass frosted?"
- "Show me the status of all room controls"

### How It Works

1. **You say:** "Show input 1 full screen with input 3 overlay at 60% opacity"

2. **Claude understands** and generates the WindowCommand:
   ```
   BV1:E:A1:2:W1S1X0Y0W100H100A0:W2S3X0Y0W100H100A60
   ```

3. **MCP server** sends command via WebSocket to Node-RED bridge

4. **Bridge validates** and forwards to Q-SYS Core

5. **Q-SYS** sends commands to Aurora DIDO hardware

6. **Display updates** with new configuration

## Available MCP Tools

The server exposes 13 tools to Claude Desktop:

### Video Wall Tools

#### `send_videowall_command`

Send WindowCommand to control video wall display.

**Parameters:**
- `command` (string): WindowCommand in compact text format

**Example:**
```json
{
  "command": "BV1:E:A1:2:W1S1X0Y0W100H100A0:W2S3X0Y0W100H100A60"
}
```

#### `get_videowall_status`

Get current hardware state from Aurora DIDO.

**Returns:**
- Current display configuration
- Active windows with geometry and transparency
- Source routing and audio configuration

#### `list_video_sources`

List all video inputs and their connection status.

**Returns:**
- IN1-IN4 connection status
- VPX encoder information
- Source names/labels

### Screen Control Tools

#### `set_screen_power`

Turn the HDMI display screen on or off.

**Parameters:**
- `enabled` (boolean): true to turn on, false to turn off

#### `get_screen_power`

Get the current screen power state.

**Returns:**
- enabled (boolean): whether screen is on or off

### Privacy Glass Tools

#### `set_privacy_glass`

Control the privacy glass frosting.

**Parameters:**
- `frosted` (boolean): true to frost (private), false to clear (transparent)

#### `get_privacy_glass`

Get the current privacy glass state.

**Returns:**
- frosted (boolean): whether glass is frosted or clear

### DIDO Output Tools

#### `set_dido_output`

Enable or disable DIDO output on the video wall (required to see the display).

**Parameters:**
- `enabled` (boolean): true to enable, false to disable

#### `get_dido_output`

Get the current DIDO output state.

**Returns:**
- enabled (boolean): whether DIDO output is active

### Lighting Tools

#### `set_lighting_level`

Set the room lighting level (Lutron LEAP Zone 1).

**Parameters:**
- `level` (number): 0-100 (0=off, 100=full brightness)

**Examples:**
- Full: 100
- Normal: 75
- Dim: 40-50
- Very dim: 20-30
- Off: 0

#### `get_lighting_level`

Get the current room lighting level.

**Returns:**
- level (number): Current lighting level (0-100)

### Volume Control Tools

#### `set_volume`

Set the main audio output volume level (Mixer_8x8_2 Output 1 Gain).

**Parameters:**
- `level` (number): -100 to +10 dB

**Examples:**
- Maximum: +10 dB
- Normal/comfortable: 0 dB
- Quiet: -20 dB
- Very quiet: -40 dB
- Minimum: -100 dB (essentially muted)

#### `get_volume`

Get the current main audio output volume level.

**Returns:**
- level (number): Current volume level in dB (-100 to +10)
- unit (string): "dB"

## WindowCommand Protocol

Claude generates commands in this format:

```
BV<version>:<flags>:<audio>:<count>:<window1>:<window2>:...[:<windowN>]
```

### Components

- **BV\<version\>**: Protocol identifier (always "BV1")
- **\<flags\>**: E=enabled, D=disabled
- **\<audio\>**: Audio output - A1, A2, A3, or A4 (maps to IN1-IN4)
- **\<count\>**: Number of windows (1-4)
- **\<windowN\>**: Window definition

### Window Format

```
W<id>S<src>X<x>Y<y>W<w>H<h>A<a>
```

- **W\<id\>**: Window ID (1-4, z-order, 1=bottom)
- **S\<src\>**: Source input (1-4 = IN1-IN4)
- **X\<x\>**: X position (0-100%)
- **Y\<y\>**: Y position (0-100%)
- **W\<w\>**: Width (1-100%)
- **H\<h\>**: Height (1-100%)
- **A\<a\>**: Alpha transparency (0=opaque, 100=transparent)

### Validation Rules

- Window 1 alpha **MUST** be 0 (opaque bottom layer)
- Geometry must not overflow: X+W ≤ 100, Y+H ≤ 100
- All values must be integers

### Example Commands

**Fullscreen:**
```
BV1:E:A1:1:W1S1X0Y0W100H100A0
```
IN1 full screen, audio from IN1

**Side-by-Side:**
```
BV1:E:A2:2:W1S2X0Y0W50H100A0:W2S3X50Y0W50H100A0
```
IN2 left half, IN3 right half, audio from IN2

**Picture-in-Picture:**
```
BV1:E:A2:2:W1S2X0Y0W100H100A0:W2S3X70Y70W25H25A0
```
IN2 full screen, IN3 small corner (25% size), audio from IN2

**Transparent Overlay:**
```
BV1:E:A1:2:W1S1X0Y0W100H100A0:W2S3X0Y0W100H100A60
```
IN1 full screen opaque, IN3 full screen 60% transparent overlay

## Architecture

```
┌─────────────────────────────┐
│  Claude Desktop             │
│  (Natural Language)         │
└──────────┬──────────────────┘
           │ MCP Protocol
           ↓
┌─────────────────────────────┐
│  MCP Server (This Package)  │
│  - Generates WindowCommand  │
│  - Manages WebSocket        │
└──────────┬──────────────────┘
           │ Socket.IO
           ↓
┌─────────────────────────────┐
│  WebSocket Bridge           │
│  (Node-RED)                 │
│  Port: 3002 (dev)/3001 (prod)│
└──────────┬──────────────────┘
           │
           ↓
┌─────────────────────────────┐
│  Q-SYS Core                 │
│  BUVideoController Plugin   │
└──────────┬──────────────────┘
           │ TCP
           ↓
┌─────────────────────────────┐
│  Aurora DIDO                │
│  192.168.100.67:6970        │
└──────────┬──────────────────┘
           │
           ↓
     Physical Display
```

## Configuration

The server automatically discovers configuration:

1. **Fetches port** from Config API (`http://localhost:1881/api/config`)
2. **Connects** to WebSocket bridge on discovered port
3. **Identifies** with platform metadata
4. **Discovers** BUControl Video Wall Controller component
5. **Subscribes** to state updates

### Default Values

- **Controller ID:** `modular-controller-config`
- **Config API Port:** `1881` (development)
- **WebSocket Port:** `3002` (development), `3001` (production)
- **Hostname:** `localhost`

## Troubleshooting

### MCP Server Won't Start

**Check Node-RED is running:**
```bash
# Development
curl http://localhost:1881/api/config

# Should return:
# {"ports":{"websocket":3002,"nodeRed":1881,"frontend":5174}}
```

**Check Claude Desktop logs:**
- Windows: `%APPDATA%\Claude\logs\`
- macOS: `~/Library/Logs/Claude/`
- Linux: `~/.config/Claude/logs/`

### Commands Not Working

**Verify WebSocket connection:**
The server logs to stderr (visible in Claude Desktop logs):
```
[MCP] Connecting to http://localhost:3002...
[MCP] Connected to WebSocket bridge
[MCP] Client identified: <client-id>
[MCP] Found video controller: <component-name> (<component-id>)
[MCP] MCP server ready
```

**Check command format:**
Commands must follow WindowCommand protocol exactly. Claude should generate valid commands based on the tool description.

### No Hardware State

If `get_videowall_status` returns "unknown":
- Hardware state is polled every 1 second from DIDO
- Wait a few seconds after connection
- Check Q-SYS Core is communicating with DIDO (192.168.100.67:6970)

## Development

### Run in Watch Mode

```bash
npm run dev
```

Changes automatically restart the server.

### Test Manually

You can test the WebSocket connection without Claude Desktop:

```bash
# Run test script from project root
node scripts/test-windowcommand-e2e.cjs
```

This validates the entire pipeline: WebSocket → Node-RED → Q-SYS → DIDO

## Protocol Reference

See documentation:
- `docs/BUVIDEOCONTROLLER_DESIGN_SPEC.md` - System architecture
- `docs/FLUTTER_WEBSOCKET_CLIENT.md` - WebSocket protocol details
- `scripts/test-windowcommand-e2e.cjs` - E2E test examples
- `scripts/test-windowcommand.cjs` - Validation logic examples

## License

MIT

## Support

For issues or questions:
1. Check logs in Claude Desktop logs directory
2. Verify Node-RED WebSocket bridge is running
3. Test with `test-windowcommand-e2e.cjs` script
4. Review protocol documentation in `docs/`
