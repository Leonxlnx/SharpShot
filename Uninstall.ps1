[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($PSScriptRoot)
$expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\SharpShot Quick'))
if (-not $target.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Uninstall is only allowed from the expected install folder: $expected"
}
$reparse = Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction Stop |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
    Select-Object -First 1
if ($reparse) { throw "Uninstall stopped because the install contains a reparse point: $($reparse.FullName)" }

Get-CimInstance Win32_Process -Filter "Name = 'SharpShot.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals(
        (Join-Path $target 'SharpShot.exe'), [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startup = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).SharpShot
$expectedCommand = '"' + (Join-Path $target 'SharpShot.exe') + '" --startup'
if ($startup -and $startup.Equals($expectedCommand, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-ItemProperty -Path $runKey -Name SharpShot -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SharpShot Quick.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'SharpShot Quick.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SharpShotQuick' -Recurse -Force -ErrorAction SilentlyContinue

$cleanup = "ping 127.0.0.1 -n 2 >nul & rmdir /s /q `"$target`""
Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $cleanup) -WindowStyle Hidden
Write-Host 'SharpShot Quick was removed. Your captures and local preferences were kept.'
