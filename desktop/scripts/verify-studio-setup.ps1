[CmdletBinding()]
param(
    [string]$PackagePath,
    [switch]$LatestSetup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# npm can launch Windows PowerShell with PowerShell 7's PSModulePath. Import the
# built-in security module by its PSHOME path so Authenticode checks do not rely
# on module auto-discovery inherited from the parent shell.
$securityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $securityModulePath -ErrorAction Stop

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$artifactsRoot = Join-Path $repoRoot 'artifacts\desktop'
. (Join-Path $repoRoot 'tools\safe-directory.ps1')

$package = Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
$numericVersion = [Version]($package.version -replace '-.*$', '')
$sevenZipCacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\7zip@1.0.0'
$sevenZipBytes = 849920
$sevenZipSha256 = '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3'

function Get-LowerSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-PeMachine([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Missing MZ header: $Path" }
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
            throw "Invalid PE header offset: $Path"
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "Missing PE signature: $Path" }
        return $reader.ReadUInt16()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

if ($LatestSetup) {
    $latest = Get-ChildItem -LiteralPath $artifactsRoot -File `
        -Filter "SharpShot-Studio-Setup-$($package.version)-win-x64.exe" |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $latest) { throw "No Studio $($package.version) Setup package found under $artifactsRoot." }
    $PackagePath = $latest.FullName
}
if (-not $PackagePath) { throw 'Pass -PackagePath or -LatestSetup.' }
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path

$installerMachine = Get-PeMachine $resolvedPackage
if ($installerMachine -ne 0x014c) {
    throw ('Expected the standard NSIS x86 bootstrap (0x014c), found 0x{0:x4}: {1}' -f $installerMachine, $resolvedPackage)
}
$versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($resolvedPackage)
if ($versionInfo.FileMajorPart -ne $numericVersion.Major -or
    $versionInfo.FileMinorPart -ne $numericVersion.Minor -or
    $versionInfo.FileBuildPart -ne $numericVersion.Build -or
    $versionInfo.FileVersion -cne $package.version -or
    $versionInfo.ProductVersion -cne $package.version) {
    throw "Setup version does not match $($package.version): $($versionInfo.FileVersion)"
}
if ($versionInfo.ProductName -cne 'SharpShot Studio') {
    throw "Setup ProductName is not SharpShot Studio: $($versionInfo.ProductName)"
}
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedPackage
if ($signature.Status -ne [Management.Automation.SignatureStatus]::NotSigned) {
    throw "Expected unsigned Setup, found Authenticode status $($signature.Status)."
}

$sevenZipCandidates = @(
    Get-ChildItem -LiteralPath $sevenZipCacheRoot -Recurse -File -Filter '7za.exe' -ErrorAction Stop |
        Where-Object {
            $_.FullName.EndsWith('\bin\7za.exe', [StringComparison]::OrdinalIgnoreCase)
        }
)
if ($sevenZipCandidates.Count -ne 1) {
    throw "Expected one electron-builder 7zip@1.0.0 x64 extractor, found $($sevenZipCandidates.Count)."
}
$sevenZip = $sevenZipCandidates[0].FullName
if ($sevenZipCandidates[0].Length -ne $sevenZipBytes -or
    (Get-LowerSha256 $sevenZip) -cne $sevenZipSha256) {
    throw 'The pinned electron-builder 7zip@1.0.0 x64 extractor is altered.'
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$operationLeaf = 'SharpShot-Setup-Verify-' + [Guid]::NewGuid().ToString('N')
$operationRoot = Join-Path $tempRoot $operationLeaf
$payloadRoot = Join-Path $operationRoot 'payload'
try {
    Assert-SafeDirectoryTarget `
        -TrustedRoot $tempRoot `
        -Path $operationRoot `
        -RequiredRelativePath $operationLeaf
    New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
    Assert-NoReparsePathComponents -TrustedRoot $tempRoot -Path $payloadRoot

    $listing = @(& $sevenZip l -t7z -slt -- $resolvedPackage 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the embedded Setup payload (7-Zip exit $LASTEXITCODE)." }
    if (@($listing | Where-Object { $_ -ceq 'Type = 7z' }).Count -ne 1 -or
        @($listing | Where-Object { $_ -match '^Offset = [1-9][0-9]*$' }).Count -ne 1 -or
        @($listing | Where-Object { $_ -ceq 'Path = SharpShot Studio.exe' }).Count -ne 1) {
        throw 'Setup does not contain one deterministic embedded 7z x64 application payload.'
    }

    $extractOutput = @(& $sevenZip x -t7z -y -bd -bb0 "-o$payloadRoot" -- $resolvedPackage 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to extract the embedded x64 payload (7-Zip exit $LASTEXITCODE): $($extractOutput -join ' | ')"
    }
    & (Join-Path $PSScriptRoot 'verify-packaged-ffmpeg.ps1') -PackagePath $payloadRoot
    Write-Output (
        'Verified unsigned NSIS Setup, exact version, embedded x64 application payload, ' +
        "runtimes, legal notices, and package allowlists in $resolvedPackage"
    )
}
finally {
    if ($null -ne (Get-PathAttributesOrNull $operationRoot)) {
        Remove-SafeDirectoryExact `
            -TrustedRoot $tempRoot `
            -Path $operationRoot `
            -RequiredRelativePath $operationLeaf
    }
}
