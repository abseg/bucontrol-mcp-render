# BUControl MCP Server - Render Deployment Guide

Complete guide for deploying the BUControl MCP Server to Render.com with Tailscale VPN support.

## Prerequisites

1. **Render.com Account**: Sign up at https://render.com
2. **GitHub Repository**: Code pushed to GitHub
3. **Tailscale Account**: For connecting to your local BUControl backend
4. **API Keys**: Generate secure API keys for authentication


S9dVhUxLSV9/fhWdyI6Ngp3TKEf1ZleDczEMWp/ebWk=



## Quick Start

### 1. Generate API Keys

```bash
# Generate a secure API key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Example output: Abc123XyzSecureKeyHere==
```

### 2. Get Tailscale Auth Key

1. Go to https://login.tailscale.com/admin/settings/keys
2. Click "Generate auth key"
3. Settings:
   - Reusable: Yes
   - Ephemeral: Yes (recommended for cloud)
   - Tags: Add `tag:server` if using ACLs
4. Copy the key (starts with `tskey-auth-`)

### 3. Deploy to Render

#### Option A: One-Click Deploy (Recommended)

1. Go to https://dashboard.render.com
2. Click "New" → "Web Service"
3. Connect your GitHub repository
4. Render will auto-detect the `render.yaml` file
5. Configure secrets (see below)
6. Click "Create Web Service"

#### Option B: Manual Configuration

1. New → Web Service
2. Connect repository
3. Configure:
   - **Name**: `bucontrol-mcp-server`
   - **Region**: Frankfurt (or closest to your backend)
   - **Branch**: `main`
   - **Runtime**: Docker
   - **Dockerfile Path**: `packages/mcp-bucontrol-server/Dockerfile`
   - **Docker Context**: `packages/mcp-bucontrol-server`
   - **Plan**: Starter ($7/month)

### 4. Configure Environment Variables

In Render Dashboard → Your Service → Environment:

#### Required Secrets (click "Add Secret")

| Key | Value | Description |
|-----|-------|-------------|
| `TAILSCALE_AUTHKEY` | `tskey-auth-xxxx` | Your Tailscale auth key |
| `API_KEYS` | `key1:premium,key2:basic` | Your API keys with tiers |

#### Environment Variables

| Key | Value | Description |
|-----|-------|-------------|
| `NODE_ENV` | `production` | Environment mode |
| `WEBSOCKET_HOST` | `100.71.254.15` | BUControl backend IP (Tailscale) |
| `WEBSOCKET_PORT` | `3004` | WebSocket bridge port |
| `CONTROLLER_ID` | `modular-controller-config` | Q-SYS controller ID |
| `TAILSCALE_HOSTNAME` | `bucontrol-mcp-render` | Hostname in Tailscale network |
| `CORS_ORIGINS` | `https://claude.ai,*` | Allowed origins |
| `REQUIRE_API_KEY` | `true` | Enforce API key auth |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `ENABLE_METRICS` | `true` | Enable Prometheus metrics |

### 5. Deploy

Click "Manual Deploy" → "Deploy latest commit" or push to your main branch.

## Verification

### Check Health

```bash
# Replace with your Render URL
curl https://bucontrol-mcp-server.onrender.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "websocket": {
    "connected": true,
    "identified": true
  },
  "components": 6,
  "uptime": 120
}
```

### Test MCP Endpoint

```bash
# List available tools
curl -X POST https://bucontrol-mcp-server.onrender.com/message \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Check Metrics

```bash
curl https://bucontrol-mcp-server.onrender.com/metrics
```

### View Logs

In Render Dashboard → Your Service → Logs

Or use Render CLI:
```bash
render logs --service bucontrol-mcp-server --tail
```

## Tailscale Setup

### On Your Local Machine (BUControl Backend)

Ensure your local machine running BUControl is connected to Tailscale:

```bash
# Check Tailscale status
tailscale status

# Your machine should show its Tailscale IP (e.g., 100.71.254.15)
```

### Verify Connectivity

Once deployed, check if Render can reach your backend:

```bash
# In Render logs, you should see:
# "Tailscale connected!"
# "Connected to WebSocket bridge"
```

### Tailscale ACLs (Optional)

If using ACLs, ensure your policy allows the Render server:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:server"],
      "dst": ["*:3004"]
    }
  ],
  "tagOwners": {
    "tag:server": ["your-email@example.com"]
  }
}
```

## Alternative: Cloudflare Tunnel

If you prefer not to use Tailscale, you can expose your backend via Cloudflare Tunnel:

### 1. Install Cloudflared

```bash
# On your local machine
brew install cloudflared  # macOS
# or
winget install Cloudflare.cloudflared  # Windows
```

### 2. Create Tunnel

```bash
cloudflared tunnel create bucontrol-backend
cloudflared tunnel route dns bucontrol-backend bucontrol-ws.yourdomain.com
```

### 3. Configure Tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: bucontrol-backend
credentials-file: /path/to/credentials.json

ingress:
  - hostname: bucontrol-ws.yourdomain.com
    service: http://localhost:3004
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

### 4. Run Tunnel

```bash
cloudflared tunnel run bucontrol-backend
```

### 5. Update Render Environment

```
WEBSOCKET_HOST=bucontrol-ws.yourdomain.com
WEBSOCKET_PORT=443
```

## Monitoring

### Prometheus Metrics

The server exposes metrics at `/metrics`:

```
mcp_requests_total 150
mcp_errors_total 2
mcp_websocket_connected 1
mcp_components_discovered 6
mcp_sessions_active 3
mcp_uptime_seconds 3600
mcp_tool_calls{tool="set_lighting_level"} 45
mcp_tool_calls{tool="get_videowall_status"} 23
```

### Health Checks

- `/health` - Overall health status
- `/ready` - Readiness probe (returns 503 if not connected)
- `/live` - Liveness probe (always returns 200)

### Alerting (Optional)

Set up alerts in Render or use external monitoring:

```bash
# Example: Check health every minute
*/1 * * * * curl -s https://your-app.onrender.com/health | jq .status
```

## Troubleshooting

### WebSocket Connection Failed

**Symptoms**: Health shows `"connected": false`

**Solutions**:
1. Check Tailscale is running on your local machine
2. Verify the Tailscale IP is correct
3. Ensure port 3004 is accessible
4. Check Render logs for connection errors

### Tailscale Not Connecting

**Symptoms**: "No TAILSCALE_AUTHKEY provided" in logs

**Solutions**:
1. Verify `TAILSCALE_AUTHKEY` is set in Render secrets
2. Check the auth key is not expired
3. Regenerate auth key if needed

### Rate Limiting

**Symptoms**: 429 Too Many Requests

**Solutions**:
1. Upgrade API key tier (premium/unlimited)
2. Increase `RATE_LIMIT_MAX` environment variable
3. Implement client-side request throttling

### Cold Starts

**Symptoms**: First request is slow (>5 seconds)

**Solutions**:
1. Use Starter plan or higher (always on)
2. Set up a health check ping to keep service warm
3. Accept cold starts on free tier

## Cost Estimate

| Component | Cost | Description |
|-----------|------|-------------|
| Render Starter | $7/month | Always-on, 512MB RAM |
| Tailscale | Free | Up to 100 devices |
| Cloudflare | Free | Unlimited tunnels |
| **Total** | **$7/month** | |

## Security Best Practices

1. **API Keys**: Use strong, random keys (32+ bytes)
2. **HTTPS**: Render provides automatic SSL
3. **Rate Limiting**: Enabled by default
4. **CORS**: Restrict to known origins in production
5. **Tailscale**: Uses WireGuard encryption
6. **Secrets**: Never commit secrets to git

## Support

- **Issues**: https://github.com/your-repo/issues
- **Render Docs**: https://render.com/docs
- **Tailscale Docs**: https://tailscale.com/kb
