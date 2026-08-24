$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

try {
  $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  $shortcutPath = Join-Path $desktop "CS2选品工具.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $script:ProjectRoot "start.bat"
  $shortcut.WorkingDirectory = $script:ProjectRoot
  $shortcut.Description = "启动 CS2 跨平台选品扫描器"
  $shortcut.Save()
  Write-AppLog "已创建桌面快捷方式：$shortcutPath"
  Write-Host "已创建桌面快捷方式：CS2选品工具"
} catch {
  Write-Host "创建桌面快捷方式失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-AppLog -Level ERROR -Message "创建桌面快捷方式失败：$($_.Exception.Message)"
  exit 1
}
