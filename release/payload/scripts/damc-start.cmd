@echo off
setlocal
rem ---------------------------------------------------------------------------
rem DAMC start. Runs HIDDEN: damc-launch.vbs launches this with no window, and the
rem installer runs it the same way. Nothing here is for a person to read on screen -
rem every line of output goes to the log, and the exit code is the report:
rem
rem   0  started (or already running)     5  database container failed to start
rem   2  Docker engine not ready in time  6  migration failed
rem   3  Docker Desktop not installed     7  containers failed to start
rem   4  image load failed                8  DAMC did not answer on :8787
rem
rem damc-launch.vbs turns those into one dialog each. This file must stay ASCII with
rem CRLF line endings (see scripts/package-release.cmd for why).
rem ---------------------------------------------------------------------------
cd /d "%~dp0.."

set "LOGDIR=%LOCALAPPDATA%\DAMC\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\damc-start.log"
set "MARK=%LOCALAPPDATA%\DAMC\images-loaded.txt"
set "IMAGE=dalur/damc:release-1.2.0"
set "TAR=%~dp0..\images\damc-images.tar"

echo [%date% %time%] start requested >> "%LOG%"

rem Host folders the container binds. C:\DAMC_IMPORT is where browser downloads of
rem AI exports are picked up; C:\DAMC_OBSIDIAN is the Obsidian vault DAMC writes.
rem Created up front so they exist the first time the user goes looking for them.
if not exist "C:\DAMC_IMPORT" mkdir "C:\DAMC_IMPORT" >nul 2>&1
if not exist "C:\DAMC_OBSIDIAN" mkdir "C:\DAMC_OBSIDIAN" >nul 2>&1

rem --- Docker engine --------------------------------------------------------
rem Docker Desktop is per-user and is frequently just not running yet - after a
rem reboot, or because the user closed it. If the engine is down but Docker Desktop
rem is installed, start it and wait for the engine here rather than handing the user
rem a "start Docker and try again": that hand-off is the step a non-technical user
rem gives up on. Only a genuinely missing Docker Desktop is left to the user, and the
rem launcher then points at the official download page - never a bundled binary.
docker version >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
    echo [%date% %time%] docker engine down - launching Docker Desktop >> "%LOG%"
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
    set "DOCKERUP="
    rem ping, not timeout: timeout fails when stdin is redirected.
    for /l %%i in (1,1,60) do (
      if not defined DOCKERUP (
        docker info >nul 2>&1 && set "DOCKERUP=1"
        if not defined DOCKERUP ping -n 4 127.0.0.1 >nul
      )
    )
    if not defined DOCKERUP (
      echo [%date% %time%] FAILED: docker engine not ready after wait >> "%LOG%"
      exit /b 2
    )
    echo [%date% %time%] docker engine ready >> "%LOG%"
  ) else (
    echo [%date% %time%] FAILED: docker desktop not installed >> "%LOG%"
    exit /b 3
  )
)

rem --- Already running? -----------------------------------------------------
rem A running DAMC answers /health. Then there is nothing to load, migrate or start,
rem and doing any of it again would only recreate a container the user is using.
curl -s -o nul -m 3 http://127.0.0.1:8787/health
if not errorlevel 1 (
  echo [%date% %time%] already running - nothing to do >> "%LOG%"
  exit /b 0
)

rem --- Images: load when missing, or when the shipped tar changed ------------
rem The tag is not build-unique (this file and docker-compose.yml both pin
rem dalur/damc:release-1.2.0), so "tag exists" alone once made an upgrade a silent
rem no-op: the new tar was ignored and the old image kept running. The marker records
rem the size and timestamp of the tar that was actually loaded; a different tar - an
rem upgrade - loads again, an unchanged one does not. First run: no marker, load.
for %%f in ("%TAR%") do set "SIG=%%~zf %%~tf"
docker image inspect %IMAGE% >nul 2>&1
if errorlevel 1 goto :doload
set "LASTSIG="
if exist "%MARK%" set /p LASTSIG=<"%MARK%"
if "%LASTSIG%"=="%SIG%" goto :loaded
:doload
echo [%date% %time%] loading images (tar %SIG%) >> "%LOG%"
docker load -i "%TAR%" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] FAILED: docker load >> "%LOG%"
  exit /b 4
)
>"%MARK%" echo %SIG%
echo [%date% %time%] images loaded >> "%LOG%"
:loaded

rem --- Database ---------------------------------------------------------------
rem Start only the database first and wait for it to accept connections. A migration
rem fired the moment the container exists races the server's own startup - a fresh
rem volume is initialised before PostgreSQL listens - so the wait is not optional.
docker compose -f "docker-compose.yml" up -d db >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] FAILED: db start >> "%LOG%"
  exit /b 5
)
set "DBREADY="
for /l %%i in (1,1,30) do (
  if not defined DBREADY (
    docker compose -f "docker-compose.yml" exec -T db pg_isready -U damc -d damc >nul 2>&1 && set "DBREADY=1"
    if not defined DBREADY ping -n 3 127.0.0.1 >nul
  )
)
if not defined DBREADY (
  echo [%date% %time%] FAILED: db readiness timeout >> "%LOG%"
  exit /b 5
)
echo [%date% %time%] db ready >> "%LOG%"

rem Migrations, retried: pg_isready can answer a moment before the server takes a
rem real connection on a first-ever start.
set "MIGRATED="
for /l %%i in (1,1,5) do (
  if not defined MIGRATED (
    docker compose -f "docker-compose.yml" run --rm app node dist/scripts/migrate.js >> "%LOG%" 2>&1 && set "MIGRATED=1"
    if not defined MIGRATED (
      echo [%date% %time%] migrate attempt did not succeed, retrying >> "%LOG%"
      ping -n 3 127.0.0.1 >nul
    )
  )
)
if not defined MIGRATED (
  echo [%date% %time%] FAILED: migrate >> "%LOG%"
  exit /b 6
)

rem --- Start -----------------------------------------------------------------
rem compose up is idempotent: a stopped container is started, a missing one created,
rem a running-and-unchanged one left alone.
docker compose -f "docker-compose.yml" up -d >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] FAILED: compose up >> "%LOG%"
  exit /b 7
)

set "READY="
for /l %%i in (1,1,40) do (
  if not defined READY (
    curl -s -o nul -m 2 http://127.0.0.1:8787/health && set "READY=1"
    if not defined READY ping -n 3 127.0.0.1 >nul
  )
)
if not defined READY (
  echo [%date% %time%] FAILED: health timeout >> "%LOG%"
  exit /b 8
)

echo [%date% %time%] started ok >> "%LOG%"
endlocal
exit /b 0
