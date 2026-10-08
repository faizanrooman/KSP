@echo off
rem One-command start of the KSP Video Evidence Management System on Windows.
rem The platform's services (PostgreSQL 16, the versitygw S3 gateway, FFmpeg) are Linux binaries, so on Windows the
rem stack runs inside WSL2 (Ubuntu) — the same start.sh used on Linux/macOS. Usage:
rem   start.bat            start (first run installs/initialises everything inside WSL)
rem   start.bat stop       stop the application processes
rem   start.bat status     show what is running
rem   start.bat logs       tail the logs
setlocal
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"

where wsl.exe >nul 2>nul
if errorlevel 1 goto nowsl
wsl.exe --status >nul 2>nul
if errorlevel 1 goto nowsl

echo KSP VMS: running ./start.sh %* inside WSL2 ...
rem --cd accepts a Windows path (incl. spaces) and maps it to /mnt/<drive>/...; bash -l loads the user's PATH (nvm, node).
wsl.exe --cd "%~dp0" bash -lc "chmod +x ./start.sh scripts/dev/*.sh 2>/dev/null; ./start.sh %*"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo start.sh exited with code %RC%. If tools are missing, install them inside WSL (the script prints the apt command^),
  echo then run start.bat again.
  exit /b %RC%
)
if /i "%ACTION%"=="start" (
  rem open the UI in the default Windows browser (port from .env; default dev port 5173)
  for /f "tokens=2 delims==" %%u in ('findstr /b "APP_BASE_URL=" "%~dp0.env" 2^>nul') do set "WEBURL=%%u"
  if defined WEBURL start "" "%WEBURL%"
)
exit /b 0

:nowsl
echo.
echo KSP VMS needs WSL2 (Windows Subsystem for Linux) on Windows.
echo   1. Open PowerShell as Administrator and run:   wsl --install -d Ubuntu
echo   2. Reboot, open "Ubuntu" once to create your Linux user, then run start.bat again.
echo.
echo Alternative without WSL: Docker Desktop with the production compose stack — see docs\DEPLOYMENT.md
echo   docker compose -f deploy\compose\docker-compose.yml --env-file deploy\compose\.env up -d
exit /b 1
