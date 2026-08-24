$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AppDirectories
$reportFile = Join-Path $script:LogsDirectory "diagnose.txt"

function Write-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail = "")
  $status = if ($Passed) { "PASS" } else { "FAIL" }
  $line = "[$status] $Name$(if ($Detail) { ' - ' + $Detail } else { '' })"
  Add-Content -LiteralPath $reportFile -Value $line -Encoding utf8
  Write-Host $line -ForegroundColor $(if ($Passed) { "Green" } else { "Red" })
}

Set-Content -LiteralPath $reportFile -Value "CS2 Price Scanner Diagnosis $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding utf8
Write-Check -Name "Project Root" -Passed (Test-Path -LiteralPath (Join-Path $script:ProjectRoot "package.json")) -Detail $script:ProjectRoot
try { $nodeExe = Get-NodeExe; Write-Check -Name "Node.js" -Passed $true -Detail (& $nodeExe --version) } catch { Write-Check -Name "Node.js" -Passed $false -Detail $_.Exception.Message }
Write-Check -Name "Dependencies" -Passed (Test-Path -LiteralPath (Join-Path $script:ProjectRoot "node_modules\next\dist\bin\next"))
$environment = Get-EnvironmentStatus
Write-Check -Name ".env.local" -Passed ([bool]$environment.File)
Write-Check -Name "CSFloat Configured" -Passed ([bool]$environment.CsFloat) -Detail $(if ($environment.CsFloat) { "CONFIGURED" } else { "NOT CONFIGURED" })
Write-Check -Name "CSQAQ Configured" -Passed ([bool]$environment.Csqaq) -Detail $(if ($environment.Csqaq) { "CONFIGURED" } else { "NOT CONFIGURED" })
Write-Check -Name "SteamDT Fallback Configured" -Passed ([bool]$environment.SteamDt) -Detail $(if ($environment.SteamDt) { "CONFIGURED" } else { "NOT CONFIGURED" })
Write-Check -Name "Domestic Provider" -Passed ([string]$environment.DomesticProvider -eq "csqaq") -Detail ([string]$environment.DomesticProvider)
Write-Check -Name "Mock Mode Disabled" -Passed ([string]$environment.MockMode -eq "false") -Detail ([string]$environment.MockMode)
Write-Check -Name "SQLite Database" -Passed (Test-Path -LiteralPath (Join-Path $script:DataDirectory "scanner.db"))
Write-Check -Name "Production Build" -Passed (Test-Path -LiteralPath (Join-Path $script:ProjectRoot ".next\BUILD_ID"))
$serverState = Read-ServerState
if (-not $serverState) { Write-Check -Name "Runtime State" -Passed $false -Detail "runtime/server.json missing; run start.bat" }
else {
  $expectedId = if ($serverState.PSObject.Properties.Name -contains "instanceId") { [string]$serverState.instanceId } else { "" }
  $processValid = Test-ProjectProcess -Id ([int]$serverState.pid)
  $tcpOwner = Get-ListeningProcessId -Port ([int]$serverState.port)
  Write-Check -Name "Next.js Process" -Passed $processValid -Detail "PID=$($serverState.pid)"
  Write-Check -Name "TCP Listening" -Passed ($tcpOwner -eq [int]$serverState.pid) -Detail "Port=$($serverState.port), OwningPID=$tcpOwner"
  Write-Check -Name "Instance Identity" -Passed ([bool]($expectedId -and (Test-AppInstance -Port ([int]$serverState.port) -ExpectedInstanceId $expectedId))) -Detail $expectedId
  $serverBaseUrl = "http://127.0.0.1:$($serverState.port)"
  try { $healthResult = Invoke-RestMethod "$serverBaseUrl/api/health" -TimeoutSec 5; Write-Check -Name "Health API" -Passed ([bool]($healthResult.status -eq "ok" -and $healthResult.database -eq "ok")) -Detail "Schema=$($healthResult.schemaVersion), Saved=$($healthResult.savedResults)" } catch { Write-Check -Name "Health API" -Passed $false -Detail $_.Exception.Message }
  try { $homepageResult = Invoke-WebRequest "$serverBaseUrl/" -UseBasicParsing -TimeoutSec 5; Write-Check -Name "Homepage" -Passed ($homepageResult.StatusCode -eq 200) } catch { Write-Check -Name "Homepage" -Passed $false -Detail $_.Exception.Message }
}
foreach ($logName in @("startup.log", "server.log", "server-error.log", "api-usage.log")) { Write-Check -Name "Log $logName" -Passed (Test-Path -LiteralPath (Join-Path $script:LogsDirectory $logName)) }
Write-Host "Diagnosis saved to $reportFile"
