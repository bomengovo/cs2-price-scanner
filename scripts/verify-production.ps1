$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AppDirectories
$verifyLog = Join-Path $script:LogsDirectory "production-verify.log"
$failures = 0

function Report([string]$Name, [bool]$Passed, [string]$Detail = "") {
  if (-not $Passed) { $script:failures += 1 }
  $status = if ($Passed) { "PASS" } else { "FAIL" }
  $line = "{0,-24} {1}{2}" -f $Name, $status, $(if ($Detail) { "  $Detail" } else { "" })
  Write-Host $line -ForegroundColor $(if ($Passed) { "Green" } else { "Red" })
  Add-Content -LiteralPath $verifyLog -Value $line -Encoding utf8
}

Set-Content -LiteralPath $verifyLog -Value "CS2 PRICE SCANNER PRODUCTION VERIFY $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding utf8
Write-Host "========================================"
Write-Host " CS2 PRICE SCANNER PRODUCTION VERIFY"
Write-Host "========================================"
Report "Project Root" (Test-Path -LiteralPath (Join-Path $script:ProjectRoot "package.json")) $script:ProjectRoot
try { $node = Get-NodeExe; Report "Node" $true (& $node --version) } catch { Report "Node" $false $_.Exception.Message }
try { $npm = Get-NpmCmd -NodeExe $node; Report "npm" $true (& $npm --version) } catch { Report "npm" $false $_.Exception.Message }
Report "Dependencies" (Test-Path -LiteralPath (Join-Path $script:ProjectRoot "node_modules\next\dist\bin\next"))
$environment = Get-EnvironmentStatus
Report ".env.local" $environment.File
Write-Host ("{0,-24} {1}" -f "CSFloat", $(if ($environment.CsFloat) { "CONFIGURED" } else { "NOT CONFIGURED" }))
Write-Host ("{0,-24} {1}" -f "CSQAQ", $(if ($environment.Csqaq) { "CONFIGURED" } else { "NOT CONFIGURED" }))
Write-Host ("{0,-24} {1}" -f "SteamDT Fallback", $(if ($environment.SteamDt) { "CONFIGURED" } else { "NOT CONFIGURED" }))
Write-Host ("{0,-24} {1}" -f "Domestic Provider", $environment.DomesticProvider.ToUpperInvariant())
Write-Host ("{0,-24} {1}" -f "Mock Mode", $environment.MockMode.ToUpperInvariant())
if (-not $environment.CsFloat -or -not $environment.Csqaq -or -not $environment.SteamDt -or $environment.DomesticProvider -ne "csqaq" -or $environment.MockMode -ne "false") { $failures += 1 }
Report "SQLite" (Test-Path -LiteralPath (Join-Path $script:DataDirectory "scanner.db"))
Report "Production Build" (Test-Path -LiteralPath (Join-Path $script:ProjectRoot ".next\BUILD_ID"))

$state = Read-ServerState
if (-not $state -or -not (Test-AppInstance -Port ([int]$state.port) -ExpectedInstanceId ([string]$state.instanceId))) {
  & (Join-Path $PSScriptRoot "start.ps1") -NoBrowser
  $state = Read-ServerState
}
$instanceOk = $state -and (Test-AppInstance -Port ([int]$state.port) -ExpectedInstanceId ([string]$state.instanceId))
Report "Server Process" $instanceOk $(if ($state) { "PID=$($state.pid)" } else { "" })
Report "Listening Port" $instanceOk $(if ($state) { [string]$state.port } else { "" })

if ($instanceOk) {
  $base = "http://127.0.0.1:$($state.port)"
  try { $health = Invoke-RestMethod "$base/api/health" -TimeoutSec 5; Report "Health API" ($health.status -eq "ok" -and $health.database -eq "ok") "Schema=$($health.schemaVersion) Saved=$($health.savedResults)" } catch { Report "Health API" $false $_.Exception.Message }
  $homepageResponse = $null
  try { $homepageResponse = Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 10; Report "Homepage" ($homepageResponse.StatusCode -eq 200) } catch { Report "Homepage" $false $_.Exception.Message }
  foreach ($api in @("results", "settings", "rate-status")) { try { $response = Invoke-WebRequest "$base/api/$api" -UseBasicParsing -TimeoutSec 10; Report ("API " + $api) ($response.StatusCode -lt 500) } catch { Report ("API " + $api) $false $_.Exception.Message } }
  $assetMatches = if ($homepageResponse) { @([regex]::Matches([string]$homepageResponse.Content, '(/_next/static/[^"'' ]+\.(?:js|css))') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique) } else { @() }
  $assetOk = $assetMatches.Count -gt 0
  foreach ($asset in $assetMatches) { try { if ((Invoke-WebRequest ($base + $asset) -UseBasicParsing -TimeoutSec 10).StatusCode -ne 200) { $assetOk = $false } } catch { $assetOk = $false } }
  Report "Static Assets" $assetOk "$($assetMatches.Count) checked"
  Push-Location $script:ProjectRoot
  try { $smokeRaw = & $node (Join-Path $PSScriptRoot "browser-smoke-test.mjs") $base; $smoke = $smokeRaw | Select-Object -Last 1 | ConvertFrom-Json; Report "Browser Render" ($smoke.status -eq "PASS") "Rows=$($smoke.tableRows), BrokenImages=$($smoke.brokenImages)"; Report "Console Errors" ($smoke.consoleErrors.Count -eq 0) "$($smoke.consoleErrors.Count)"; Report "Page Errors" ($smoke.pageErrors.Count -eq 0) "$($smoke.pageErrors.Count)" } catch { Report "Browser Render" $false $_.Exception.Message }
  finally { Pop-Location }
  Write-Host "URL                     $base"
}

$final = if ($failures -eq 0) { "PASS" } else { "FAIL" }
Write-Host ""
Write-Host "FINAL STATUS            $final" -ForegroundColor $(if ($failures -eq 0) { "Green" } else { "Red" })
Add-Content -LiteralPath $verifyLog -Value "FINAL STATUS $final" -Encoding utf8
exit $(if ($failures -eq 0) { 0 } else { 1 })
