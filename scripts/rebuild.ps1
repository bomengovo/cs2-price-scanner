[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

try {
  Initialize-AppDirectories
  Write-Host "正在停止旧服务..."
  & (Join-Path $PSScriptRoot "stop.ps1")
  $nextDirectory = Join-Path $script:ProjectRoot ".next"
  if (Test-Path -LiteralPath $nextDirectory) {
    $resolvedNext = (Resolve-Path -LiteralPath $nextDirectory).Path
    $expectedNext = Join-Path $script:ProjectRoot ".next"
    if (-not $resolvedNext.Equals($expectedNext, [System.StringComparison]::OrdinalIgnoreCase)) { throw "拒绝清理非项目 .next 目录：$resolvedNext" }
    Remove-Item -LiteralPath $resolvedNext -Recurse -Force
  }
  $nodeExe = Get-NodeExe
  $npmCmd = Get-NpmCmd -NodeExe $nodeExe
  Invoke-ProductionBuild -NpmCmd $npmCmd
  Write-Host "构建完成，正在启动网站..."
  & (Join-Path $PSScriptRoot "start.ps1") -SkipBuildCheck -NoBrowser:$NoBrowser
  exit $LASTEXITCODE
} catch {
  Write-Host "重建失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-AppLog -Level ERROR -Message "重建失败：$($_.Exception.Message)"
  exit 1
}
