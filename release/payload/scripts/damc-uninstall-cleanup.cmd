@echo off
rem Removes DAMC containers. The data volume is only removed when called with
rem the "purge" argument, which the uninstaller asks about separately.
setlocal
cd /d "%~dp0.."
docker version >nul 2>&1
if errorlevel 1 exit /b 0
docker compose -f "docker-compose.yml" down >nul 2>&1
if /i "%~1"=="purge" (
  rem Both volumes. damc_damc_pg is the memory database; damc_damc_storage holds
  rem retained Claude export archives and generated Obsidian/JSON exports, which are
  rem the same user data the uninstaller's prompt asks about. Removing one and
  rem silently keeping the other would answer that question dishonestly.
  docker volume rm damc_damc_pg >nul 2>&1
  docker volume rm damc_damc_storage >nul 2>&1
)
endlocal
exit /b 0
