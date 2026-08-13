# tools/make-shortcut.ps1 — 바탕화면에 원클릭 바로가기 생성/재생성
# 폴더를 옮긴 뒤에는 이 스크립트를 다시 실행하면 바로가기가 새 위치로 복구된다.
# 실행: powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "좌석 시야 미리보기.lnk"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $root "실행.bat"
$lnk.WorkingDirectory = $root
$lnk.IconLocation = (Join-Path $root "assets\icon.ico") + ",0"
$lnk.Description = "CGV 좌석 시야 미리보기"
$lnk.Save()
Write-Host "바로가기 생성: $lnkPath"
