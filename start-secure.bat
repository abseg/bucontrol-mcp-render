@echo off
REM ============================================================================
REM BUControl MCP Server - Secure Startup Script
REM ============================================================================

echo.
echo ========================================================================
echo BUControl MCP Server - Security Checklist
echo ========================================================================
echo.

REM Check if .env file exists
if not exist .env (
    echo [ERROR] .env file not found!
    echo.
    echo Please create .env file from .env.example:
    echo   1. Copy .env.example to .env
    echo   2. Generate API key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    echo   3. Update API_KEYS in .env
    echo   4. Configure BIND_ADDRESS (recommended: VPN IP only)
    echo.
    pause
    exit /b 1
)

REM Check if API keys are configured
findstr /C:"API_KEYS=" .env >nul 2>&1
if errorlevel 1 (
    echo [ERROR] API_KEYS not configured in .env!
    echo.
    echo Generate a secure API key:
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    echo.
    echo Then add to .env: API_KEYS=your-generated-key-here
    echo.
    pause
    exit /b 1
)

REM Display current configuration
echo [INFO] Current Configuration:
echo.
findstr /C:"BIND_ADDRESS=" .env
findstr /C:"HTTP_PORT=" .env
findstr /C:"HTTPS_PORT=" .env
findstr /C:"ENABLE_AUDIT_LOG=" .env
echo.

REM Warn if binding to 0.0.0.0
findstr /C:"BIND_ADDRESS=0.0.0.0" .env >nul 2>&1
if not errorlevel 1 (
    echo [WARNING] !!! SECURITY RISK !!!
    echo You are binding to 0.0.0.0 (all interfaces)
    echo This exposes the server to your entire network!
    echo.
    echo Recommended: Use your VPN IP (100.71.254.15) or localhost (127.0.0.1)
    echo.
    set /p CONTINUE="Continue anyway? (yes/no): "
    if /i not "%CONTINUE%"=="yes" (
        echo.
        echo Startup cancelled. Please update BIND_ADDRESS in .env
        pause
        exit /b 1
    )
)

echo.
echo ========================================================================
echo Starting MCP Server...
echo ========================================================================
echo.

REM Start the server
node server.js

if errorlevel 1 (
    echo.
    echo [ERROR] Server failed to start!
    echo.
    pause
    exit /b 1
)
