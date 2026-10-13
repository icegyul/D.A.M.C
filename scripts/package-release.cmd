@echo off
setlocal enabledelayedexpansion
rem ---------------------------------------------------------------------------
rem Build the DAMC Windows release bundle.
rem
rem Why this exists: the release used to be assembled by hand, and the payload it
rem ships is a PREBUILT DOCKER IMAGE TAR - not loose JavaScript. `npm run build`
rem does not touch that tar, and damc-start.cmd only `docker load`s it when the
rem image tag is absent, so a rebuilt dist/ never reaches an installed machine.
rem The 1.2.0 bundle was found shipping an image that predated migration 005 and
rem three new modules for exactly this reason.
rem
rem This file must stay ASCII with CRLF line endings. cmd.exe mis-parses a .cmd
rem saved with bare LF - it splits lines at the wrong bytes, runs fragments as
rem commands, and still exits 0, which is exactly how an earlier revision of this
rem script appeared to succeed while doing nothing.
rem
rem Run from the project root:  scripts\package-release.cmd
rem
rem Requires: Docker Desktop running, network access (the Dockerfile downloads a
rem pinned cloudflared), and Inno Setup 6 for the final step.
rem ---------------------------------------------------------------------------

cd /d "%~dp0.."

rem Version comes from package.json so there is nothing here to keep in sync.
rem Cleared first: an inherited VERSION from the caller's environment would
rem otherwise survive a failed read and tag the image with the wrong value.
set "VERSION="
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "VERSION=%%v"
echo %VERSION% | findstr /r /c:"^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (
  echo [FAIL] could not read a valid version from package.json ^(got "%VERSION%"^)
  exit /b 1
)
set "IMAGE=dalur/damc:release-%VERSION%"
echo === DAMC release %VERSION% ===

rem release\installer\DAMC.iss bundles ..\..\integrations\* from the LIVE working
rem tree, so whatever sits there is shipped to end users. Surfaced, not enforced.
for /f "usebackq delims=" %%s in (`git status --porcelain -- integrations 2^>nul`) do (
  echo [WARN] integrations/ has uncommitted changes - they WILL ship inside the installer:
  echo        %%s
)

echo [1/7] install dependencies
rem ci, not install: a release must build from the lockfile. No fallback - an
rem `npm install` here would silently re-resolve and rewrite package-lock.json.
call npm ci || exit /b 1

echo [2/7] build
call npm run build || exit /b 1

rem DAMC_REQUIRE_DB makes the database-backed files fail instead of skipping.
rem Without it a release can be signed off by a test run that never touched
rem Postgres. Needs damc_test: CREATE DATABASE damc_test OWNER damc.
echo [3/7] test (database required)
set "DAMC_REQUIRE_DB=1"
call npm test || exit /b 1
set "DAMC_REQUIRE_DB="

echo [4/7] build the runtime image %IMAGE%
docker build -t %IMAGE% . || exit /b 1

echo [5/7] pull postgres:17-alpine
docker pull postgres:17-alpine || exit /b 1

echo [6/7] save both images into the installer payload
rem Staged through a temp name and moved only on success: DAMC.iss packages
rem images\* by glob, so a half-written or stale tar left in that directory would
rem be shipped, and the directory is gitignored so nothing would reveal it.
set "IMAGES_DIR=release\payload\images"
if not exist "%IMAGES_DIR%" mkdir "%IMAGES_DIR%"
if exist "%IMAGES_DIR%\damc-images.tar.new" del /q "%IMAGES_DIR%\damc-images.tar.new"
docker save -o "%IMAGES_DIR%\damc-images.tar.new" %IMAGE% postgres:17-alpine || exit /b 1
for %%f in ("%IMAGES_DIR%\*") do if /i not "%%~nxf"=="damc-images.tar.new" del /q "%%~f"
move /y "%IMAGES_DIR%\damc-images.tar.new" "%IMAGES_DIR%\damc-images.tar" >nul || exit /b 1

echo [7/7] compile the installer
rem release\installer\DAMC.iss carries its own #define AppVersion - keep it equal
rem to package.json, and note payload\docker-compose.yml and
rem payload\scripts\damc-start.cmd both name the image tag above.
rem
rem Inno Setup's own installer defaults to a PER-USER location and does not add
rem itself to PATH, so `where ISCC.exe` alone reports it missing on a machine that
rem has it. Check the standard install directories too - looking only at PATH is
rem what made an earlier pass conclude Inno Setup was absent when it was not.
set "ISCC_EXE="
for /f "delims=" %%p in ('where ISCC.exe 2^>nul') do if not defined ISCC_EXE set "ISCC_EXE=%%p"
if not defined ISCC_EXE (
  for %%d in (
    "%LOCALAPPDATA%\Programs\Inno Setup 6"
    "%ProgramFiles(x86)%\Inno Setup 6"
    "%ProgramFiles%\Inno Setup 6"
  ) do if not defined ISCC_EXE if exist "%%~d\ISCC.exe" set "ISCC_EXE=%%~d\ISCC.exe"
)
if not defined ISCC_EXE (
  echo.
  echo [SKIP] ISCC.exe not found - the payload is current but DAMC_Setup.exe was NOT rebuilt.
  echo        Install it:  winget install --id JRSoftware.InnoSetup --scope user
  echo        Then re-run this script.
  exit /b 2
)
echo   using !ISCC_EXE!
"!ISCC_EXE!" "release\installer\DAMC.iss" || exit /b 1
if not exist "release\DAMC_Setup.exe" (
  echo [FAIL] ISCC reported success but release\DAMC_Setup.exe does not exist
  exit /b 1
)

echo.
echo === computing SHA256 ===
rem Written with the same layout the published checksum file has always had, and
rem without a BOM, so a user following the documented verify steps sees the same
rem shape of file. Fails loudly rather than emitting a blank hash.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $p='release\DAMC_Setup.exe'; $h=(Get-FileHash $p -Algorithm SHA256).Hash; $s=(Get-Item $p).Length; $mb=[math]::Round($s/1MB,2); $nl=[char]13+[char]10; $t='DAMC %VERSION% - release checksum'+$nl+$nl+'File   : DAMC_Setup.exe'+$nl+('Size   : {0} bytes ({1} MB)' -f $s,$mb)+$nl+('SHA256 : {0}' -f $h)+$nl+$nl+'Verify on Windows:'+$nl+'  certutil -hashfile DAMC_Setup.exe SHA256'+$nl+'  Get-FileHash DAMC_Setup.exe -Algorithm SHA256'+$nl; [IO.File]::WriteAllText((Resolve-Path 'release').Path+'\DAMC_SHA256.txt',$t,(New-Object Text.UTF8Encoding $false)); Write-Host $h" || exit /b 1

echo.
echo === release %VERSION% built ===
for %%f in ("release\DAMC_Setup.exe") do echo   installer: %%~ff  (%%~zf bytes, %%~tf)
echo   image    : %IMAGE%
echo   payload  : release\payload\images\damc-images.tar
endlocal
