$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AppDirectories
$holder = $null
$results = [ordered]@{ wrongPid = $false; stalePid = $false; portConflict = $false; finalRestart = $false }

try {
  & (Join-Path $PSScriptRoot "stop.ps1") | Out-Host
  for ($attempt = 1; $attempt -le 20 -and (Get-ListeningProcessId -Port 3000) -ne 0; $attempt += 1) { Start-Sleep -Milliseconds 250 }
  if ((Get-ListeningProcessId -Port 3000) -ne 0) { throw "Port 3000 did not release after scanner stop" }
  $node = Get-NodeExe
  $holder = Start-Process -FilePath $node -ArgumentList @((Join-Path $PSScriptRoot "port-holder.mjs"), "3000") -PassThru -WindowStyle Hidden
  for ($attempt = 1; $attempt -le 20 -and (Get-ListeningProcessId -Port 3000) -ne $holder.Id; $attempt += 1) { Start-Sleep -Milliseconds 250 }
  if ((Get-ListeningProcessId -Port 3000) -ne $holder.Id) { throw "Port holder failed to listen on 3000" }

  @{ pid = $holder.Id; port = 3000; instanceId = "wrong-process"; projectRoot = $script:ProjectRoot } | ConvertTo-Json | Set-Content -LiteralPath $script:StateFile -Encoding utf8
  & (Join-Path $PSScriptRoot "stop.ps1") | Out-Host
  $results.wrongPid = $null -ne (Get-Process -Id $holder.Id -ErrorAction SilentlyContinue)

  @{ pid = 999999; port = 3000; instanceId = "stale-process"; projectRoot = $script:ProjectRoot } | ConvertTo-Json | Set-Content -LiteralPath $script:StateFile -Encoding utf8
  & (Join-Path $PSScriptRoot "start.ps1") -NoBrowser | Out-Host
  $state = Read-ServerState
  $results.stalePid = $state -and [int]$state.pid -ne 999999 -and (Test-AppInstance -Port ([int]$state.port) -ExpectedInstanceId ([string]$state.instanceId))
  $results.portConflict = $state -and [int]$state.port -ge 3001 -and [int]$state.port -le 3010 -and $null -ne (Get-Process -Id $holder.Id -ErrorAction SilentlyContinue)
  & (Join-Path $PSScriptRoot "stop.ps1") | Out-Host
} finally {
  if ($holder -and (Get-Process -Id $holder.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $holder.Id -Force }
  Start-Sleep -Seconds 1
  & (Join-Path $PSScriptRoot "start.ps1") -NoBrowser | Out-Host
  $finalState = Read-ServerState
  $results.finalRestart = $finalState -and (Test-AppInstance -Port ([int]$finalState.port) -ExpectedInstanceId ([string]$finalState.instanceId))
  $results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:LogsDirectory "launcher-tests.json") -Encoding utf8
}

$results | ConvertTo-Json
if ($results.Values -contains $false) { exit 1 }
