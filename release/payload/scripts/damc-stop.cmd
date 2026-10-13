@echo off
setlocal
title DAMC - Stopping
cd /d "%~dp0.."
docker version >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running; nothing to stop.
  exit /b 0
)
echo Stopping DAMC...
docker compose -f "docker-compose.yml" stop
echo.
echo   DAMC stopped. Your memory data is kept.
echo.
endlocal
exit /b 0
