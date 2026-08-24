$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AppDirectories

try {
  $taskName = "CS2 Price Scanner"
  $startScript = Join-Path $PSScriptRoot "start.ps1"
  $taskAction = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -NoBrowser"
  & schtasks.exe /Create /TN $taskName /TR $taskAction /SC ONLOGON /RL LIMITED /F | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-AppLog "已启用计划任务开机自启。"
    Write-Host "已启用 Windows 登录后自动启动。"
    exit 0
  }
  throw "计划任务创建失败。"
} catch {
  $startupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  $fallback = Join-Path $startupDir "CS2 Price Scanner Auto Start.cmd"
  $startScript = Join-Path $PSScriptRoot "start.ps1"
  "@echo off`r`nstart `"CS2 Price Scanner`" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -NoBrowser" | Set-Content -LiteralPath $fallback -Encoding ascii
  Write-AppLog -Level WARN -Message "计划任务不可用，已改用当前用户启动文件夹自启。"
  Write-Host "已启用登录后自动启动（当前用户启动文件夹）。"
  exit 0
}
