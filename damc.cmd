@echo off
setlocal
rem DAMC command-line wrapper.
rem
rem   damc import chatgpt "C:\path\to\conversations.json"
rem   damc import claude  "C:\path\to\conversations.zip"
rem   damc ai setup cursor --apply
rem   damc ai context <project>
rem
rem A thin shim over npm scripts, which is what actually runs (see
rem scripts/import-export.ts and src/cli/ai.ts). Nothing is duplicated here:
rem argument parsing, formatting and file merging all live in src/cli/*.ts.

if /I "%~1"=="import" goto :import
if /I "%~1"=="ai"     goto :ai
if /I "%~1"=="help"   goto :usage
if /I "%~1"=="--help" goto :usage
if "%~1"==""          goto :usage
echo Unknown command: %~1
goto :usage

:import
if "%~2"=="" goto :usage
if "%~3"=="" goto :usage
call npm run --silent damc:import -- "%~2" "%~3"
exit /b %ERRORLEVEL%

:ai
shift
call npm run --silent damc:ai -- %*
exit /b %ERRORLEVEL%

:usage
echo DAMC
echo.
echo   damc import chatgpt "^<path to export.json or .zip^>"
echo   damc import claude  "^<path to export.json or .zip^>"
echo   damc ai setup claude [--apply] [--url URL] [--key KEY]
echo   damc ai setup cursor [--apply] [--project DIR]
echo   damc ai skill cursor --apply [--project DIR]
echo   damc ai context ^<project^>
echo   damc ai status
echo.
echo Run this from the DAMC project folder. Equivalent to:
echo   npm run damc:import -- chatgpt "^<path^>"
exit /b 1
