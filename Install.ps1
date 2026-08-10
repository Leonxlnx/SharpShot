[CmdletBinding()]
param([switch]$NoLaunch)

$ErrorActionPreference = 'Stop'
$product = 'SharpShot Quick'
$source = [IO.Path]::GetFullPath($PSScriptRoot)
$programs = Join-Path $env:LOCALAPPDATA 'Programs'
$target = Join-Path $programs $product
$stage = "$target.installing-$PID"
$rollback = "$target.rollback-$PID"
$required = @('SharpShot.exe', 'SharpShot.exe.config', 'README.md', 'LICENSE', 'Install.cmd', 'Install.ps1', 'Uninstall.ps1')
$cutoverComplete = $false

function Remove-ExactTree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to remove reparse point: $Path"
    }
    $reparseChild = Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        Select-Object -First 1
    if ($reparseChild) { throw "Refusing to remove a tree containing a reparse point: $($reparseChild.FullName)" }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Stop-InstalledApp {
    Get-CimInstance Win32_Process -Filter "Name = 'SharpShot.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals(
            (Join-Path $target 'SharpShot.exe'), [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
}

function New-Shortcut([string]$Path, [string]$Executable) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Executable
    $shortcut.WorkingDirectory = Split-Path -Parent $Executable
    $shortcut.Description = 'Fast local screenshots and screen recordings'
    $shortcut.IconLocation = "$Executable,0"
    $shortcut.Save()
}

if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
if ($source.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run Install.ps1 from an extracted download, not from the existing install folder.'
}
foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) {
        throw "The install package is incomplete: $name is missing."
    }
}

$checksumPath = Join-Path $source 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw 'SHA256SUMS.txt is missing.' }
$seen = @()
foreach ($line in Get-Content -LiteralPath $checksumPath) {
    if ($line -notmatch '^([0-9A-F]{64})  ([^\\/:*?"<>|]+)$') { throw "Invalid checksum entry: $line" }
    $file = Join-Path $source $Matches[2]
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Checksummed file is missing: $($Matches[2])" }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Matches[1]) {
        throw "Checksum mismatch: $($Matches[2])"
    }
    $seen += $Matches[2]
}
$expectedChecksums = @($required | Sort-Object)
if ($seen.Count -ne $expectedChecksums.Count -or (Compare-Object $expectedChecksums @($seen | Sort-Object))) {
    throw 'SHA256SUMS.txt does not contain the exact install file set.'
}

New-Item -ItemType Directory -Path $programs -Force | Out-Null
Remove-ExactTree $stage
Remove-ExactTree $rollback
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($name in $required + 'SHA256SUMS.txt') {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $stage $name)
    }
    $testRoot = Join-Path $env:TEMP "SharpShot-Quick-install-test-$PID"
    $test = Start-Process -FilePath (Join-Path $stage 'SharpShot.exe') -ArgumentList @('--self-test', ('"' + $testRoot + '"')) -Wait -PassThru -WindowStyle Hidden
    Remove-ExactTree $testRoot
    if ($test.ExitCode -ne 0) { throw "The installed app self-test failed with exit code $($test.ExitCode)." }

    Stop-InstalledApp
    if (Test-Path -LiteralPath $target) { Rename-Item -LiteralPath $target -NewName (Split-Path -Leaf $rollback) }
    try { Rename-Item -LiteralPath $stage -NewName (Split-Path -Leaf $target) }
    catch {
        if (Test-Path -LiteralPath $rollback) { Rename-Item -LiteralPath $rollback -NewName (Split-Path -Leaf $target) }
        throw
    }
    $cutoverComplete = $true

    $exe = Join-Path $target 'SharpShot.exe'
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SharpShot Quick.lnk'
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'SharpShot Quick.lnk'
    New-Shortcut $desktopShortcut $exe
    New-Shortcut $startMenu $exe

    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SharpShotQuick'
    New-Item -Path $uninstallKey -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name DisplayName -Value $product -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value '1.5.0' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name Publisher -Value 'Leonxlnx' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $target -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name DisplayIcon -Value $exe -PropertyType String -Force | Out-Null
    $uninstall = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $target 'Uninstall.ps1')`""
    New-ItemProperty -Path $uninstallKey -Name UninstallString -Value $uninstall -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null

    if (-not $NoLaunch) { Start-Process -FilePath $exe }
    Remove-ExactTree $rollback
    Write-Host "$product is installed. Use Win+Shift+D for screenshots and Win+Shift+A for video."
}
catch {
    if ($cutoverComplete) {
        Stop-InstalledApp
        Remove-ExactTree $target
        if (Test-Path -LiteralPath $rollback) {
            Rename-Item -LiteralPath $rollback -NewName (Split-Path -Leaf $target)
        }
    }
    Remove-ExactTree $stage
    throw
}
