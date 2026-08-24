$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AppDirectories

try {
  $state = Read-ServerState
  if (-not $state) { Write-Host "当前没有运行中的 CS2 选品扫描器。"; exit 0 }
  $processId = [int]$state.pid
  $stopMarker = Join-Path $script:RuntimeDirectory "stop.requested"
  $expectedInstanceId = if ($state.PSObject.Properties.Name -contains "instanceId") { [string]$state.instanceId } else { "" }
  if (-not $expectedInstanceId -or -not (Test-AppInstance -Port ([int]$state.port) -ExpectedInstanceId $expectedInstanceId) -or (Get-ListeningProcessId -Port ([int]$state.port)) -ne $processId) {
    Remove-ServerState
    Write-Host "状态文件未通过 PID/TCP/Health/InstanceId 校验；未终止任何进程，已清理过期状态。"
    exit 0
  }
  "requested $(Get-Date -Format o)" | Set-Content -LiteralPath $stopMarker -Encoding utf8
  Stop-Process -Id $processId -Force
  $supervisorFile = Join-Path $script:RuntimeDirectory "supervisor.json"
  if (Test-Path -LiteralPath $supervisorFile) {
    try {
      $supervisor = Get-Content -LiteralPath $supervisorFile -Raw | ConvertFrom-Json
      if ([int]$supervisor.supervisorPid -gt 0 -and (Test-ProjectProcess -Id ([int]$supervisor.supervisorPid))) {
        Stop-Process -Id ([int]$supervisor.supervisorPid) -Force -ErrorAction SilentlyContinue
      }
    } catch { Write-AppLog -Level WARN -Message "监督进程状态清理失败：$($_.Exception.Message)" }
  }
  Remove-Item -LiteralPath $supervisorFile -Force -ErrorAction SilentlyContinue
  Remove-ServerState
  Write-AppLog "已停止本项目服务器 PID=$processId，端口=$($state.port)。"
  Write-Host "CS2 选品扫描器已关闭。"
  exit 0
} catch {
  Write-Host "停止失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-AppLog -Level ERROR -Message "停止失败：$($_.Exception.Message)"
  exit 1
}
