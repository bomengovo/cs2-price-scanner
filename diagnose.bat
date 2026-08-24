@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\diagnose.ps1"
pause
