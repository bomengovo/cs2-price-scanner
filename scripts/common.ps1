Set-StrictMode -Version Latest

$script:ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$script:LogsDirectory = Join-Path $script:ProjectRoot "logs"
$script:RuntimeDirectory = Join-Path $script:ProjectRoot "runtime"
$script:DataDirectory = Join-Path $script:ProjectRoot "data"
$script:StartupLog = Join-Path $script:LogsDirectory "startup.log"
$script:ServerLog = Join-Path $script:LogsDirectory "server.log"
$script:ErrorLog = Join-Path $script:LogsDirectory "error.log"
$script:StateFile = Join-Path $script:RuntimeDirectory "server.json"

function Initialize-AppDirectories {
  foreach ($directory in @($script:LogsDirectory, $script:RuntimeDirectory, $script:DataDirectory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
}

function Write-AppLog {
  param([Parameter(Mandatory)][string]$Message, [ValidateSet("INFO", "WARN", "ERROR")][string]$Level = "INFO")
  Initialize-AppDirectories
  $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  Add-Content -LiteralPath $script:StartupLog -Value $line -Encoding utf8
  if ($Level -eq "ERROR") { Add-Content -LiteralPath $script:ErrorLog -Value $line -Encoding utf8 }
}

function Show-Step {
  param([Parameter(Mandatory)][string]$Text)
  Write-Host $Text
  Write-AppLog $Text
}

function Get-NodeExe {
  $fromPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  $candidate = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path -LiteralPath $candidate) {
    $env:Path = "$(Split-Path -Parent $candidate);$env:Path"
    return $candidate
  }
  throw "未检测到 Node.js。请先安装 Node.js LTS，然后再次双击 start.bat。"
}

function Get-NpmCmd {
  param([Parameter(Mandatory)][string]$NodeExe)
  $candidate = Join-Path (Split-Path -Parent $NodeExe) "npm.cmd"
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  $fromPath = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  throw "检测到 Node.js，但未检测到 npm.cmd。请重新安装 Node.js LTS。"
}

function Get-EnvironmentStatus {
  $file = Join-Path $script:ProjectRoot ".env.local"
  if (-not (Test-Path -LiteralPath $file)) { return @{ File = $false; SteamDt = $false; CsFloat = $false; Csqaq = $false; DomesticProvider = ""; MockMode = "" } }
  $content = Get-Content -LiteralPath $file -Raw -ErrorAction Stop
  function Test-ConfiguredValue([string]$Name) {
    $match = [regex]::Match($content, "(?:^|[^A-Za-z0-9_])" + [regex]::Escape($Name) + "\s*=\s*([^\s``#]+)", "Multiline")
    return $match.Success -and -not [string]::IsNullOrWhiteSpace($match.Groups[1].Value) -and $match.Groups[1].Value.Trim() -notmatch '^\*+$'
  }
  function Get-PublicSetting([string]$Name) {
    $match = [regex]::Match($content, "(?:^|[^A-Za-z0-9_])" + [regex]::Escape($Name) + "\s*=\s*([^\s``#]+)", "Multiline")
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return ""
  }
  return @{ File = $true; SteamDt = (Test-ConfiguredValue "STEAMDT_API_KEY"); CsFloat = (Test-ConfiguredValue "CSFLOAT_API_KEY"); Csqaq = (Test-ConfiguredValue "CSQAQ_API_TOKEN"); DomesticProvider = (Get-PublicSetting "DOMESTIC_PROVIDER"); MockMode = (Get-PublicSetting "MOCK_MODE") }
}

function Get-AppHealth {
  param([Parameter(Mandatory)][int]$Port)
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -ErrorAction Stop
    if ($response.status -eq "ok" -and $response.app -eq "cs2-price-scanner" -and $response.database -eq "ok") { return $response }
    return $null
  } catch { return $null }
}

function Test-AppHealth {
  param([Parameter(Mandatory)][int]$Port)
  return $null -ne (Get-AppHealth -Port $Port)
}

function Test-PortAvailable {
  param([Parameter(Mandatory)][int]$Port)
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch { return $false }
  finally { if ($listener) { $listener.Stop() } }
}

function Get-AvailablePort {
  foreach ($port in 3000..3010) {
    if (Test-PortAvailable -Port $port) { return $port }
  }
  throw "端口 3000 到 3010 均被占用，无法启动网站。"
}

function Read-ServerState {
  if (-not (Test-Path -LiteralPath $script:StateFile)) { return $null }
  try { return Get-Content -LiteralPath $script:StateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Remove-ServerState { Remove-Item -LiteralPath $script:StateFile -Force -ErrorAction SilentlyContinue }

function Test-ProjectProcess {
  param([Parameter(Mandatory)][int]$Id)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
  if (-not $process -or -not $process.CommandLine) { return $false }
  return $process.CommandLine.IndexOf($script:ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-ListeningProcessId {
  param([Parameter(Mandatory)][int]$Port)
  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
  } catch { }
  return 0
}

function Test-AppInstance {
  param([Parameter(Mandatory)][int]$Port, [string]$ExpectedInstanceId = "")
  $health = Get-AppHealth -Port $Port
  if (-not $health) { return $false }
  $healthPid = [int]$health.pid
  if ($healthPid -le 0 -or -not (Test-ProjectProcess -Id $healthPid)) { return $false }
  if ((Get-ListeningProcessId -Port $Port) -ne $healthPid) { return $false }
  if ($ExpectedInstanceId -and [string]$health.instanceId -ne $ExpectedInstanceId) { return $false }
  return $true
}

function Test-BuildRequired {
  $buildMarker = Join-Path $script:ProjectRoot ".next\BUILD_ID"
  if (-not (Test-Path -LiteralPath $buildMarker)) { return $true }
  $builtAt = (Get-Item -LiteralPath $buildMarker).LastWriteTimeUtc
  $watch = @(
    (Join-Path $script:ProjectRoot "src"),
    (Join-Path $script:ProjectRoot "package.json"),
    (Join-Path $script:ProjectRoot "next.config.ts"),
    (Join-Path $script:ProjectRoot "tsconfig.json")
  )
  foreach ($path in $watch) {
    if (Test-Path -LiteralPath $path) {
      $latest = if ((Get-Item -LiteralPath $path).PSIsContainer) {
        Get-ChildItem -LiteralPath $path -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      } else { Get-Item -LiteralPath $path }
      if ($latest -and $latest.LastWriteTimeUtc -gt $builtAt) { return $true }
    }
  }
  return $false
}

function Invoke-ProductionBuild {
  param([Parameter(Mandatory)][string]$NpmCmd)
  Show-Step "正在构建生产版本，请稍候..."
  Push-Location $script:ProjectRoot
  try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $NpmCmd run build 2>&1 | Tee-Object -FilePath $script:ServerLog -Append
    $ErrorActionPreference = $previousPreference
    if ($LASTEXITCODE -ne 0) { throw "Next.js 构建失败，详见 logs\\server.log。" }
  } finally { Pop-Location }
}
