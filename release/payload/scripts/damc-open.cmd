@echo off
setlocal
cd /d "%~dp0"
curl -s -o nul -m 2 http://127.0.0.1:8787/health
if errorlevel 1 (
  call "%~dp0damc-start.cmd"
  if errorlevel 1 exit /b 1
)
start "" "http://127.0.0.1:8787"
endlocal
exit /b 0
