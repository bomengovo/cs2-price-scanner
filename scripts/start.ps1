[CmdletBinding()]
param([switch]$NoBrowser, [switch]$SkipBuildCheck)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

try {
  Initialize-AppDirectories
  Show-Step "========================================"
  Show-Step "CS2 跨平台选品扫描器启动器"
  Show-Step "========================================"
  Show-Step "[1/7] 检查 Node.js..."
  $nodeExe = Get-NodeExe
  $npmCmd = Get-NpmCmd -NodeExe $nodeExe
  Show-Step "✓ Node.js 正常：$(& $nodeExe --version)"
  Show-Step "[2/7] 检查依赖..."
  $nextCli = Join-Path $script:ProjectRoot "node_modules\next\dist\bin\next"
  if (-not (Test-Path -LiteralPath $nextCli)) {
    Show-Step "依赖缺失，正在安装..."
    Push-Location $script:ProjectRoot
    try {
      $previousPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      if (Test-Path -LiteralPath (Join-Path $script:ProjectRoot "package-lock.json")) { & $npmCmd ci 2>&1 | Tee-Object -FilePath $script:ServerLog -Append } else { & $npmCmd install 2>&1 | Tee-Object -FilePath $script:ServerLog -Append }
      $ErrorActionPreference = $previousPreference
      if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，详见 logs\\server.log。" }
    } finally { Pop-Location }
  }
  Show-Step "✓ 依赖正常"
  Show-Step "[3/7] 检查环境配置..."
  $environment = Get-EnvironmentStatus
  if (-not $environment.File) { Show-Step "⚠ 未找到 .env.local；网站仍会启动，但需要的 API 功能会提示未配置。" } else {
    Show-Step "✓ 配置文件：PASS"
    Show-Step "  CSFloat：$(if ($environment.CsFloat) { 'CONFIGURED' } else { 'NOT CONFIGURED' })"
    Show-Step "  CSQAQ：$(if ($environment.Csqaq) { 'CONFIGURED' } else { 'NOT CONFIGURED' })"
    Show-Step "  SteamDT Fallback：$(if ($environment.SteamDt) { 'CONFIGURED' } else { 'NOT CONFIGURED' })"
    Show-Step "  Domestic Provider：$($environment.DomesticProvider.ToUpperInvariant())"
    Show-Step "  Mock Mode：$($environment.MockMode.ToUpperInvariant())"
  }
  $env:DB_PATH = Join-Path $script:DataDirectory "scanner.db"
  # Node 24 fetch does not consume HTTP(S)_PROXY unless this switch is enabled.
  # Keep provider calls on the same configured egress as the rest of this machine.
  $env:NODE_USE_ENV_PROXY = "1"
  Show-Step "[4/7] 检查 SQLite 数据库..."
  Show-Step "✓ 数据库固定路径：$env:DB_PATH"
  Show-Step "[5/7] 检查端口..."
  $state = Read-ServerState
  if ($state) {
    $expectedInstanceId = if ($state.PSObject.Properties.Name -contains "instanceId") { [string]$state.instanceId } else { "" }
    if ($expectedInstanceId -and (Test-AppInstance -Port ([int]$state.port) -ExpectedInstanceId $expectedInstanceId) -and [int]$state.pid -eq (Get-ListeningProcessId -Port ([int]$state.port))) {
      Show-Step "✓ 当前生产实例已通过 PID/TCP/Health/InstanceId 交叉验证，端口 $($state.port)。"
      if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$($state.port)" }
      exit 0
    }
    Show-Step "⚠ 检测到 stale 或不匹配的 runtime\server.json；不会终止未知进程，已安全清理。"
    Remove-ServerState
  }
  foreach ($knownPort in 3000..3010) {
    if (Test-AppInstance -Port $knownPort) {
      $existingHealth = Get-AppHealth -Port $knownPort
      @{ pid = [int]$existingHealth.pid; port = $knownPort; instanceId = [string]$existingHealth.instanceId; buildId = [string]$existingHealth.buildId; startedAt = [string]$existingHealth.startedAt; projectRoot = $script:ProjectRoot; appVersion = [string]$existingHealth.appVersion } | ConvertTo-Json | Set-Content -LiteralPath $script:StateFile -Encoding utf8
      Show-Step "✓ 已恢复识别当前项目实例，端口 $knownPort。"
      if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$knownPort" }
      exit 0
    }
  }
  $port = Get-AvailablePort
  if ($port -ne 3000) { Show-Step "⚠ 端口 3000 被其他程序占用，改用端口 $port。" } else { Show-Step "✓ 使用端口 3000" }
  if (-not $SkipBuildCheck -and (Test-BuildRequired)) { Invoke-ProductionBuild -NpmCmd $npmCmd } else { Show-Step "✓ 生产构建可用" }
  Show-Step "[6/7] 启动生产服务器..."
  Remove-Item -LiteralPath (Join-Path $script:RuntimeDirectory "stop.requested") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $script:RuntimeDirectory "supervisor.json") -Force -ErrorAction SilentlyContinue
  $instanceId = [guid]::NewGuid().ToString()
  $startedAt = (Get-Date).ToString("o")
  $env:SCANNER_INSTANCE_ID = $instanceId
  $env:SCANNER_STARTED_AT = $startedAt
  $runner = Join-Path $PSScriptRoot "run-production-server.cmd"
  $commandLine = '"' + $env:ComSpec + '" /d /s /c ""' + $runner + '" "' + $nodeExe + '" "' + $nextCli + '" ' + $port + ' "' + $instanceId + '" "' + $startedAt + '""'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $script:ProjectRoot }
  if ([int]$created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) { throw "后台 Node 进程创建失败（WMI ReturnValue=$($created.ReturnValue)）。" }
  $createdPid = [int]$created.ProcessId
  Show-Step "[7/7] 健康检查..."
  $healthy = $false
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    $health = Get-AppHealth -Port $port
    if ($health -and [string]$health.instanceId -eq $instanceId) { $healthy = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) {
    if (Test-ProjectProcess -Id $createdPid) { Stop-Process -Id $createdPid -Force -ErrorAction SilentlyContinue }
    Remove-ServerState
    throw "网站未能在 60 秒内通过健康检查。请查看 logs\\server.log 和 logs\\error.log。"
  }
  $actualPid = [int]$health.pid
  if (-not (Test-ProjectProcess -Id $actualPid) -or (Get-ListeningProcessId -Port $port) -ne $actualPid) { throw "健康检查通过，但监听 PID 未通过项目归属校验。" }
  @{ pid = $actualPid; port = $port; instanceId = $instanceId; buildId = [string]$health.buildId; startedAt = $startedAt; projectRoot = $script:ProjectRoot; appVersion = [string]$health.appVersion } | ConvertTo-Json | Set-Content -LiteralPath $script:StateFile -Encoding utf8
  Show-Step "✓ 网站启动成功：http://127.0.0.1:$port（PID=$actualPid，Instance=$instanceId）"
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port" }
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-Host "启动失败：$message" -ForegroundColor Red
  Write-AppLog -Level ERROR -Message "启动失败：$message"
  exit 1
}
