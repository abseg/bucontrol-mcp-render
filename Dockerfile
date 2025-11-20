# =============================================================================
# BUControl MCP Server - Production Dockerfile with Tailscale Support
# =============================================================================
FROM node:20-alpine

# Install dependencies for Tailscale and health checks
RUN apk add --no-cache \
    wget \
    curl \
    iptables \
    ip6tables \
    iproute2 \
    ca-certificates

# Install Tailscale
RUN wget -q https://pkgs.tailscale.com/stable/tailscale_1.56.1_amd64.tgz -O /tmp/tailscale.tgz && \
    tar -xzf /tmp/tailscale.tgz -C /tmp && \
    cp /tmp/tailscale_*/tailscale /usr/local/bin/ && \
    cp /tmp/tailscale_*/tailscaled /usr/local/bin/ && \
    rm -rf /tmp/tailscale* && \
    mkdir -p /var/run/tailscale /var/lib/tailscale /var/cache/tailscale

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy source files
COPY . .

# Create non-root user for security (but Tailscale needs root)
# We'll run node as non-root but tailscaled as root
RUN addgroup -S mcpuser && adduser -S mcpuser -G mcpuser && \
    chown -R mcpuser:mcpuser /app

# Create startup script that handles Tailscale
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'set -e' >> /app/start.sh && \
    echo '' >> /app/start.sh && \
    echo '# Start Tailscale daemon if auth key is provided' >> /app/start.sh && \
    echo 'if [ -n "$TAILSCALE_AUTHKEY" ]; then' >> /app/start.sh && \
    echo '  echo "Starting Tailscale daemon..."' >> /app/start.sh && \
    echo '  tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock &' >> /app/start.sh && \
    echo '  sleep 2' >> /app/start.sh && \
    echo '  echo "Connecting to Tailscale network..."' >> /app/start.sh && \
    echo '  tailscale up --authkey=$TAILSCALE_AUTHKEY --hostname=${TAILSCALE_HOSTNAME:-bucontrol-mcp-render}' >> /app/start.sh && \
    echo '  echo "Tailscale connected!"' >> /app/start.sh && \
    echo '  tailscale status' >> /app/start.sh && \
    echo 'else' >> /app/start.sh && \
    echo '  echo "No TAILSCALE_AUTHKEY provided, running without Tailscale"' >> /app/start.sh && \
    echo 'fi' >> /app/start.sh && \
    echo '' >> /app/start.sh && \
    echo '# Start the MCP server' >> /app/start.sh && \
    echo 'exec node server-http.js' >> /app/start.sh && \
    chmod +x /app/start.sh

# Expose MCP server port (Render will set PORT env var)
EXPOSE ${PORT:-3100}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT:-3100}/health || exit 1

# Start with Tailscale support
CMD ["/app/start.sh"]
