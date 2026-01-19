@echo off
REM Start script for AFK console client
cd /d "%~dp0"
REM Clean up old processes if any
taskkill /F /IM node.exe >nul 2>&1
echo Starting AFK console client...
REM Use npm start so scripts from package.json run
npm start
pause
