# Distribution Guide

This folder is ready to be shared as a complete MCP server package.

## Package Contents

```
mcp-bucontrol-server/
├── index.js           # Main MCP server (stdio transport for Claude Desktop)
├── server.js          # Remote MCP server (HTTPS/SSE transport for iPad/remote)
├── package.json       # Dependencies and scripts
├── README.md          # Full documentation
├── INSTALL.md         # Quick installation guide
├── LICENSE            # MIT License
├── setup.bat          # Windows setup script
├── setup.sh           # macOS/Linux setup script
└── .gitignore         # Git ignore rules
```

## Option 1: Share as Folder/ZIP

1. **Exclude these files** (they're regenerated on installation):
   - `node_modules/`
   - `package-lock.json`
   - `server.key`
   - `server.cert`
   - Any `.log` files

2. **Create a ZIP:**
   ```bash
   # From parent directory
   zip -r mcp-bucontrol-server.zip mcp-bucontrol-server \
     -x "mcp-bucontrol-server/node_modules/*" \
     -x "mcp-bucontrol-server/server.key" \
     -x "mcp-bucontrol-server/server.cert"
   ```

3. **Recipients run:**
   ```bash
   # Windows
   setup.bat

   # macOS/Linux
   ./setup.sh
   ```

## Option 2: Publish to npm

If you want to publish this to npm for easy installation:

1. **Update package.json** (optional):
   ```json
   {
     "name": "@yourorg/bucontrol-mcp",
     "repository": {
       "type": "git",
       "url": "https://github.com/yourorg/bucontrol-mcp"
     }
   }
   ```

2. **Publish:**
   ```bash
   npm login
   npm publish --access public
   ```

3. **Users install with:**
   ```bash
   npm install -g @yourorg/bucontrol-mcp
   ```

## Option 3: GitHub Repository

1. **Create a new repo:**
   ```bash
   cd mcp-bucontrol-server
   git init
   git add .
   git commit -m "Initial commit: BUControl MCP Server"
   git remote add origin https://github.com/yourorg/bucontrol-mcp.git
   git push -u origin main
   ```

2. **Users install with:**
   ```bash
   git clone https://github.com/yourorg/bucontrol-mcp.git
   cd bucontrol-mcp
   npm install
   ```

## Configuration Required

After installation, users MUST edit these files to match their network:

### index.js (lines 19-23)
```javascript
const CONFIG = {
  controllerId: 'modular-controller-config',
  websocketPort: 3004,        // Their WebSocket port
  hostname: '100.71.254.15'   // Their VPN/server IP
};
```

### server.js (lines 22-26)
```javascript
const CONFIG = {
  controllerId: 'modular-controller-config',
  websocketPort: 3004,        // Their WebSocket port
  hostname: '100.71.254.15',  // Their VPN/server IP
  httpPort: 3100              // MCP HTTPS port
};
```

## Support

Point users to:
- `README.md` - Complete documentation
- `INSTALL.md` - Quick setup guide
- Claude Desktop logs for troubleshooting

## Example Distribution Message

```
# BUControl MCP Server

Control your BUControl room automation system using natural language with Claude Desktop!

## Quick Start

1. Unzip the package
2. Run setup.bat (Windows) or ./setup.sh (macOS/Linux)
3. Edit index.js and server.js to configure your network
4. Follow INSTALL.md to add to Claude Desktop

## Features

- Natural language control for video wall, lights, volume, privacy glass, and more
- iPad/remote access via HTTPS
- Real-time status monitoring
- 13 different control tools

For full documentation, see README.md
```

## Version Management

When releasing updates:

1. Update version in `package.json`
2. Add release notes to `README.md`
3. Tag the release if using git:
   ```bash
   git tag -a v1.0.1 -m "Bug fixes and improvements"
   git push origin v1.0.1
   ```
