@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
set "SCANNER_INSTANCE_ID=%~4"
set "SCANNER_STARTED_AT=%~5"
set "DB_PATH=%CD%\data\scanner.db"
set "NODE_USE_ENV_PROXY=1"
"%~1" "scripts\server-supervisor.mjs" "%~1" "%~2" "%~3" "%~4" "%~5" 1>>"logs\supervisor.log" 2>>"logs\supervisor-error.log"
exit /b %ERRORLEVEL%
