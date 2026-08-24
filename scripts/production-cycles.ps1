$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AppDirectories
$nodeExeForCycles = Get-NodeExe
$savedBaseline = $null
$cycleResults = @()

function Test-ProductionCycle {
  param([int]$CycleNumber, [string]$CyclePhase)
  $currentState = Read-ServerState
  if (-not $currentState) { throw "Cycle $CycleNumber $CyclePhase missing state" }
  if (-not (Test-AppInstance -Port ([int]$currentState.port) -ExpectedInstanceId ([string]$currentState.instanceId))) { throw "Cycle $CycleNumber $CyclePhase instance failed" }
  $baseUrl = "http://127.0.0.1:$($currentState.port)"
  $healthResult = Invoke-RestMethod "$baseUrl/api/health" -TimeoutSec 5
  if ($healthResult.status -ne "ok" -or $healthResult.database -ne "ok") { throw "Cycle $CycleNumber $CyclePhase health failed" }
  foreach ($testPath in @("/", "/api/results", "/api/settings", "/api/rate-status")) {
    if ((Invoke-WebRequest ($baseUrl + $testPath) -UseBasicParsing -TimeoutSec 10).StatusCode -ne 200) { throw "Cycle $CycleNumber $CyclePhase $testPath failed" }
  }
  if ($null -eq $script:savedBaseline) { $script:savedBaseline = [int]$healthResult.savedResults }
  if ([int]$healthResult.savedResults -lt $script:savedBaseline) { throw "Cycle $CycleNumber result count decreased" }
  $browserJson = & $nodeExeForCycles (Join-Path $PSScriptRoot "browser-smoke-test.mjs") $baseUrl
  $browserResult = $browserJson | Select-Object -Last 1 | ConvertFrom-Json
  if ($browserResult.status -ne "PASS") { throw "Cycle $CycleNumber $CyclePhase browser failed" }
  return [ordered]@{ phase = $CyclePhase; pid = [int]$healthResult.pid; port = [int]$currentState.port; savedResults = [int]$healthResult.savedResults; browser = $browserResult.status; consoleErrors = $browserResult.consoleErrors.Count; pageErrors = $browserResult.pageErrors.Count }
}

for ($cycleNumber = 1; $cycleNumber -le 3; $cycleNumber += 1) {
  Write-Host "Production Cycle $cycleNumber start"
  if ($cycleNumber -eq 3) {
    & (Join-Path $PSScriptRoot "rebuild.ps1") -NoBrowser | Out-Host
  } else {
    & (Join-Path $PSScriptRoot "stop.ps1") | Out-Host
    & (Join-Path $PSScriptRoot "start.ps1") -NoBrowser | Out-Host
  }
  $beforeWait = Test-ProductionCycle -CycleNumber $cycleNumber -CyclePhase "initial"
  Write-Host "Cycle $cycleNumber initial PASS; waiting 60 seconds"
  Start-Sleep -Seconds 60
  $afterWait = Test-ProductionCycle -CycleNumber $cycleNumber -CyclePhase "after60s"
  $cycleResults += [ordered]@{ cycle = $cycleNumber; status = "PASS"; initial = $beforeWait; after60s = $afterWait }
  $cycleResults | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $script:LogsDirectory "production-cycles.json") -Encoding utf8
  Write-Host "Production Cycle $cycleNumber PASS"
}

$cycleResults | ConvertTo-Json -Depth 6
