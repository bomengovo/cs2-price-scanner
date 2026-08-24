$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AppDirectories

& schtasks.exe /Delete /TN "CS2 Price Scanner" /F 2>$null | Out-Null
$startupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
Remove-Item -LiteralPath (Join-Path $startupDir "CS2 Price Scanner Auto Start.cmd") -Force -ErrorAction SilentlyContinue
Write-AppLog "已移除开机自启配置。"
Write-Host "已移除开机自启配置。"
