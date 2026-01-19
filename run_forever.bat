@echo off
REM run_forever.bat - restarts the bot when it exits
cd /d "%~dp0"
if not exist logs\events mkdir logs\events
REM Clean up old processes
taskkill /F /IM node.exe >nul 2>&1
echo [%date% %time%] Supervisor started >> logs\events\events.log
:loop
echo [%date% %time%] Starting bot (npm start)... >> logs\events\events.log
call npm start
set EXITCODE=%ERRORLEVEL%
echo [%date% %time%] Bot exited with code %EXITCODE% >> logs\events\events.log
REM wait a few seconds before restarting
timeout /t 5 /nobreak >nul
goto loop
