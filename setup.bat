@echo off
echo ========================================
echo BUControl MCP Server Setup
echo ========================================
echo.

echo [1/4] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)
echo.

echo [2/4] Checking for OpenSSL...
where openssl >nul 2>nul
if %errorlevel% neq 0 (
    echo WARNING: OpenSSL not found. You'll need to generate SSL certificates manually.
    echo Install from: https://slproweb.com/products/Win32OpenSSL.html
    goto :skip_cert
)

echo [3/4] Generating SSL certificates...
if exist server.key (
    echo SSL certificates already exist. Skipping...
) else (
    echo.
    echo IMPORTANT: The certificate CN must match your VPN/server hostname!
    echo Default: localhost (for local testing only)
    echo For production: Use your VPN IP (e.g., 100.71.254.15)
    echo.
    set /p CN="Enter hostname for certificate (default: localhost): "
    if "%CN%"=="" set CN=localhost

    powershell -Command "openssl req -nodes -new -x509 -keyout server.key -out server.cert -days 365 -subj '/C=US/ST=State/L=City/O=BUControl/CN=%CN%'"
    if %errorlevel% neq 0 (
        echo ERROR: Failed to generate SSL certificates
        pause
        exit /b 1
    )
)
echo.

:skip_cert

echo [4/4] Configuration...
echo.
echo IMPORTANT: Edit index.js and server.js to configure your network:
echo   - Set hostname to your VPN/server IP
echo   - Set websocketPort to your WebSocket bridge port
echo.
echo Example configuration:
echo   const CONFIG = {
echo     controllerId: 'modular-controller-config',
echo     websocketPort: 3004,
echo     hostname: '100.71.254.15'
echo   };
echo.

echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo To add to Claude Desktop:
echo 1. Edit: %%APPDATA%%\Claude\claude_desktop_config.json
echo 2. Add this server configuration (see INSTALL.md)
echo 3. Restart Claude Desktop
echo.
echo To start remote server:
echo   npm run start:remote
echo.
pause
