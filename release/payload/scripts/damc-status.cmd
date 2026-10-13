@echo off
setlocal
title DAMC - Status
cd /d "%~dp0.."
echo === Docker ===
docker version --format "engine {{.Server.Version}}" 2>nul || echo Docker Desktop is not running.
echo.
echo === Containers ===
docker compose -f "docker-compose.yml" ps
echo.
echo === Health ===
curl -s -m 5 http://127.0.0.1:8787/health
echo.
echo.
echo Logs: %LOCALAPPDATA%\DAMC\logs
pause
endlocal
