# Connecting to MCP Server from Outside

## 🎯 Current Server Configuration

**Server IP (Tailscale VPN):** `100.71.254.15`
**HTTP Port:** `3100`
**HTTPS Port:** `3443`
**API Key:** `Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=`

**Binding:** VPN-only (Tailscale) - Most secure ✅

---

## 📱 iPad/iPhone Setup (Recommended)

### Step 1: Install Tailscale

1. Open **App Store**
2. Search for **"Tailscale"**
3. Tap **Get** → **Install**
4. Open the app
5. Tap **Get Started**
6. **Sign in** with the same account you used on your Windows PC
   - Use the same email/provider (Google, Microsoft, etc.)
7. Tap **Connect** or toggle the switch to ON
8. You should see "Connected" status

### Step 2: Verify Connection

1. Open **Safari** (or any browser)
2. Navigate to: `http://100.71.254.15:3100/health`
3. You should see a JSON response like:
   ```json
   {
     "status": "ok",
     "websocket": "connected",
     "identified": true,
     "components": ["videoWall", "hdmiDisplay", "gpio", ...]
   }
   ```

✅ If you see this, you're connected successfully!

### Step 3: Use in Apps

**For Claude Desktop/MCP apps:**
- Server URL: `http://100.71.254.15:3100/sse`
- Add header: `x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=`

**For web apps:**
```javascript
fetch('http://100.71.254.15:3100/sse', {
  headers: {
    'x-api-key': 'Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI='
  }
})
```

**For native iOS apps:**
```swift
var request = URLRequest(url: URL(string: "http://100.71.254.15:3100/sse")!)
request.setValue("Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=", forHTTPHeaderField: "x-api-key")
```

---

## 💻 Android Setup

### Step 1: Install Tailscale

1. Open **Google Play Store**
2. Search for **"Tailscale"**
3. Tap **Install**
4. Open the app
5. Tap **Sign in**
6. Use the **same account** as your Windows PC
7. Tap **Connect**

### Step 2: Test Connection

1. Open **Chrome** or any browser
2. Go to: `http://100.71.254.15:3100/health`
3. Should see server status

---

## 🖥️ Another Computer (Windows/Mac/Linux)

### Step 1: Install Tailscale

**Windows:**
1. Go to: https://tailscale.com/download/windows
2. Download and run installer
3. Sign in with same account
4. Click "Connect"

**Mac:**
1. Go to: https://tailscale.com/download/mac
2. Download and install
3. Sign in and connect

**Linux:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

### Step 2: Test Connection

**Browser:**
```
http://100.71.254.15:3100/health
```

**Command Line:**
```bash
curl http://100.71.254.15:3100/health
```

**With API Key:**
```bash
curl -H "x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=" \
     http://100.71.254.15:3100/sse
```

---

## 🌐 Alternative: Local Network Access (No VPN)

If you don't want to use Tailscale and all devices are on the **same WiFi network**:

### Step 1: Change Server Binding

Edit `packages/mcp-bucontrol-server/.env`:

```env
# Change from VPN IP to local network IP
BIND_ADDRESS=192.168.100.53
```

### Step 2: Restart Server

```batch
cd packages\mcp-bucontrol-server
start-secure.bat
```

### Step 3: Connect from Any Device on WiFi

**New URL:** `http://192.168.100.53:3100/health`

**⚠️ Security Warning:**
- Anyone on your WiFi can now access the server
- Make sure API keys are strong
- Consider using firewall rules
- Not recommended for sensitive controls

---

## 🧪 Testing Your Connection

### Quick Browser Test

1. **Health Check (No Auth):**
   ```
   http://100.71.254.15:3100/health
   ```
   Expected: `{"status":"ok","websocket":"connected"...}`

2. **Protected Endpoint (Should Fail):**
   ```
   http://100.71.254.15:3100/sse
   ```
   Expected: `{"error":"Unauthorized"...}`

### Interactive Test Page

Save this as `test.html` on your device:

```html
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>BUControl Connection Test</title>
    <style>
        body { font-family: sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; }
        button { padding: 10px 20px; margin: 10px 0; font-size: 16px; }
        pre { background: #f5f5f5; padding: 10px; overflow: auto; }
        .success { color: green; }
        .error { color: red; }
        input { width: 100%; padding: 8px; margin: 10px 0; box-sizing: border-box; }
    </style>
</head>
<body>
    <h1>🎮 BUControl Connection Test</h1>

    <h2>1. Health Check (No Auth)</h2>
    <button onclick="testHealth()">Test Connection</button>
    <pre id="health-result">Click button to test...</pre>

    <h2>2. Authenticated Request</h2>
    <label>API Key:</label>
    <input type="text" id="api-key"
           value="Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=">
    <button onclick="testAuth()">Test with API Key</button>
    <pre id="auth-result">Click button to test...</pre>

    <h2>3. Video Wall Status</h2>
    <button onclick="getStatus()">Get Video Wall Status</button>
    <pre id="status-result">Click button to test...</pre>

    <script>
        const SERVER = 'http://100.71.254.15:3100';

        async function testHealth() {
            const result = document.getElementById('health-result');
            try {
                result.textContent = '⏳ Testing connection...';
                result.className = '';

                const response = await fetch(`${SERVER}/health`);
                const data = await response.json();

                result.textContent = '✅ SUCCESS!\n\n' + JSON.stringify(data, null, 2);
                result.className = 'success';
            } catch (error) {
                result.textContent = '❌ FAILED!\n\n' +
                    'Error: ' + error.message + '\n\n' +
                    'Troubleshooting:\n' +
                    '1. Is the server running?\n' +
                    '2. Are you connected to Tailscale?\n' +
                    '3. Is the server address correct?';
                result.className = 'error';
            }
        }

        async function testAuth() {
            const result = document.getElementById('auth-result');
            const apiKey = document.getElementById('api-key').value.trim();

            if (!apiKey) {
                result.textContent = '❌ Please enter an API key';
                result.className = 'error';
                return;
            }

            try {
                result.textContent = '⏳ Testing authentication...';
                result.className = '';

                const response = await fetch(`${SERVER}/sse`, {
                    headers: {
                        'x-api-key': apiKey
                    }
                });

                if (response.ok) {
                    result.textContent = '✅ AUTHENTICATION SUCCESS!\n\n' +
                        'You are authorized to use the MCP server.\n' +
                        'SSE stream connection initiated.';
                    result.className = 'success';
                } else {
                    const data = await response.json();
                    result.textContent = '❌ AUTHENTICATION FAILED!\n\n' +
                        JSON.stringify(data, null, 2) + '\n\n' +
                        'Check your API key in .env file';
                    result.className = 'error';
                }
            } catch (error) {
                result.textContent = '❌ ERROR!\n\n' + error.message;
                result.className = 'error';
            }
        }

        async function getStatus() {
            const result = document.getElementById('status-result');
            const apiKey = document.getElementById('api-key').value.trim();

            try {
                result.textContent = '⏳ Getting video wall status...';
                result.className = '';

                // This would use the MCP protocol in a real implementation
                // For now, just show that authentication works
                const response = await fetch(`${SERVER}/health`, {
                    headers: {
                        'x-api-key': apiKey
                    }
                });

                const data = await response.json();
                result.textContent = '✅ Server is accessible!\n\n' +
                    'Components: ' + (data.components || []).join(', ') + '\n\n' +
                    'To control the video wall, use the MCP protocol\n' +
                    'through your MCP client application.';
                result.className = 'success';
            } catch (error) {
                result.textContent = '❌ ERROR!\n\n' + error.message;
                result.className = 'error';
            }
        }
    </script>
</body>
</html>
```

Save this to your device and open it in Safari/Chrome to test the connection interactively.

---

## 🔧 Troubleshooting

### "Cannot connect" or "Connection refused"

**Check:**
1. Is the server running on your PC?
   ```bash
   netstat -ano | findstr "3100"
   ```
   Should show: `100.71.254.15:3100 ... LISTENING`

2. Are you connected to Tailscale on both devices?
   - Open Tailscale app
   - Verify "Connected" status
   - Both devices should be on same Tailnet

3. Test from the server itself:
   ```bash
   curl http://100.71.254.15:3100/health
   ```

### "Unauthorized" Error

**Check:**
1. API key is correct (no extra spaces)
2. Using correct header: `x-api-key` (lowercase)
3. API key matches `.env` file

### "CORS Error" in Browser

**Fix:**
Add your origin to `.env`:
```env
ALLOWED_ORIGINS=https://claude.ai,http://localhost:3100,https://your-app-domain.com
```

Restart server.

### Can't See Tailscale IP

**On remote device:**
```bash
# Check if Tailscale is connected
tailscale status

# Should show your PC's IP: 100.71.254.15
```

---

## 📊 Connection Methods Summary

| Method | Security | Setup | Use Case |
|--------|----------|-------|----------|
| **Tailscale VPN** | ⭐⭐⭐⭐⭐ | Medium | Remote access from anywhere (Recommended) |
| **Local Network** | ⭐⭐⭐ | Easy | Same WiFi only |
| **Internet (Port Forward)** | ⭐⭐ | Hard | Public access (Not recommended) |
| **Localhost** | ⭐⭐⭐⭐⭐ | Easy | Same machine only (Testing) |

---

## 🎯 Quick Reference

### Server URLs

```
Health Check:    http://100.71.254.15:3100/health
MCP Endpoint:    http://100.71.254.15:3100/sse
HTTPS (if SSL):  https://100.71.254.15:3443/sse
```

### API Key Header

```
x-api-key: Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=
```

### Example Requests

**JavaScript:**
```javascript
fetch('http://100.71.254.15:3100/sse', {
  headers: { 'x-api-key': 'YOUR_KEY_HERE' }
})
```

**Python:**
```python
requests.get('http://100.71.254.15:3100/sse',
             headers={'x-api-key': 'YOUR_KEY_HERE'})
```

**cURL:**
```bash
curl -H "x-api-key: YOUR_KEY_HERE" http://100.71.254.15:3100/sse
```

---

## 🔐 Security Reminders

1. ✅ Keep API key secret
2. ✅ Only share with trusted devices
3. ✅ Use Tailscale VPN for remote access
4. ✅ Monitor audit.log for suspicious activity
5. ✅ Rotate API keys periodically

---

**Need help?** See [SECURITY.md](SECURITY.md) for detailed security guide.
