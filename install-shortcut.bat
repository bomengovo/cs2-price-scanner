@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-desktop-shortcut.ps1"
if errorlevel 1 pause
