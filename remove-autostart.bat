@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remove-autostart.ps1"
if errorlevel 1 pause
