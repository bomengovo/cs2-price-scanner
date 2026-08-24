@echo off
setlocal EnableExtensions
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Startup failed. See logs\startup.log, then press any key to close.
  pause >nul
)
exit /b %EXIT_CODE%
