#!/bin/bash

echo "========================================"
echo "BUControl MCP Server Setup"
echo "========================================"
echo

echo "[1/4] Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install dependencies"
    exit 1
fi
echo

echo "[2/4] Checking for OpenSSL..."
if ! command -v openssl &> /dev/null; then
    echo "WARNING: OpenSSL not found. Install it to generate SSL certificates."
    echo "  macOS: brew install openssl"
    echo "  Linux: apt-get install openssl or yum install openssl"
    skip_cert=true
fi
echo

if [ "$skip_cert" != true ]; then
    echo "[3/4] Generating SSL certificates..."
    if [ -f server.key ]; then
        echo "SSL certificates already exist. Skipping..."
    else
        echo ""
        echo "IMPORTANT: The certificate CN must match your VPN/server hostname!"
        echo "Default: localhost (for local testing only)"
        echo "For production: Use your VPN IP (e.g., 100.71.254.15)"
        echo ""
        read -p "Enter hostname for certificate (default: localhost): " CN
        CN=${CN:-localhost}

        openssl req -nodes -new -x509 -keyout server.key -out server.cert -days 365 -subj "/C=US/ST=State/L=City/O=BUControl/CN=$CN"
        if [ $? -ne 0 ]; then
            echo "ERROR: Failed to generate SSL certificates"
            exit 1
        fi
        chmod 600 server.key server.cert
    fi
    echo
fi

echo "[4/4] Configuration..."
echo
echo "IMPORTANT: Edit index.js and server.js to configure your network:"
echo "  - Set hostname to your VPN/server IP"
echo "  - Set websocketPort to your WebSocket bridge port"
echo
echo "Example configuration:"
echo "  const CONFIG = {"
echo "    controllerId: 'modular-controller-config',"
echo "    websocketPort: 3004,"
echo "    hostname: '100.71.254.15'"
echo "  };"
echo

echo "========================================"
echo "Setup Complete!"
echo "========================================"
echo
echo "To add to Claude Desktop:"
echo "1. Edit: ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)"
echo "        or ~/.config/Claude/claude_desktop_config.json (Linux)"
echo "2. Add this server configuration (see INSTALL.md)"
echo "3. Restart Claude Desktop"
echo
echo "To start remote server:"
echo "  npm run start:remote"
echo
