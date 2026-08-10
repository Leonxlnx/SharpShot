[CmdletBinding()]
param(
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDirectory = Join-Path $desktopRoot 'resources\ffmpeg\win32-x64'
$manifestPath = Join-Path $runtimeDirectory 'runtime-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "FFmpeg manifest not found: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

function Get-Sha256([string]$Path) {
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

function Assert-ManifestFile([string]$Path, $Entry) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Pinned FFmpeg archive is missing $($Entry.archivePath)."
    }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ne [Int64]$Entry.bytes) {
        throw "Unexpected byte count for $($Entry.name): $($item.Length), expected $($Entry.bytes)."
    }
    $hash = Get-Sha256 $Path
    if ($hash -ne [string]$Entry.sha256) {
        throw "Unexpected SHA-256 for $($Entry.name): $hash."
    }
}

$temporaryDirectory = $null
try {
    if ($ArchivePath) {
        $archive = (Resolve-Path -LiteralPath $ArchivePath).Path
    }
    else {
        $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) (
            'SharpShot-FFmpeg-' + [Guid]::NewGuid().ToString('N')
        )
        New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
        $archive = Join-Path $temporaryDirectory ([string]$manifest.archiveName)
        Write-Output "Downloading pinned FFmpeg runtime from $($manifest.archiveUrl)"
        [Net.ServicePointManager]::SecurityProtocol = (
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        )
        Invoke-WebRequest -UseBasicParsing -Uri ([string]$manifest.archiveUrl) -OutFile $archive
    }

    $archiveItem = Get-Item -LiteralPath $archive
    if ($archiveItem.Length -ne [Int64]$manifest.archiveBytes) {
        throw "FFmpeg archive byte count is $($archiveItem.Length), expected $($manifest.archiveBytes)."
    }
    $archiveHash = Get-Sha256 $archive
    if ($archiveHash -ne [string]$manifest.archiveSha256) {
        throw "FFmpeg archive SHA-256 is $archiveHash, expected $($manifest.archiveSha256)."
    }

    if (-not $temporaryDirectory) {
        $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) (
            'SharpShot-FFmpeg-' + [Guid]::NewGuid().ToString('N')
        )
        New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    }
    $expandedDirectory = Join-Path $temporaryDirectory 'expanded'
    Expand-Archive -LiteralPath $archive -DestinationPath $expandedDirectory
    $archiveRoot = Join-Path $expandedDirectory ([string]$manifest.archiveRoot)
    if (-not (Test-Path -LiteralPath $archiveRoot -PathType Container)) {
        throw "Pinned FFmpeg archive root not found: $archiveRoot"
    }

    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    foreach ($entry in $manifest.files) {
        if ($null -eq $entry.archivePath) { continue }
        $archiveRelativePath = ([string]$entry.archivePath).Replace(
            '/', [IO.Path]::DirectorySeparatorChar
        )
        $sourcePath = Join-Path $archiveRoot $archiveRelativePath
        Assert-ManifestFile $sourcePath $entry
        Copy-Item -LiteralPath $sourcePath -Destination (
            Join-Path $runtimeDirectory ([string]$entry.name)
        ) -Force
    }

    $verifyScript = Join-Path $PSScriptRoot 'verify-ffmpeg.ps1'
    & $verifyScript -RuntimeDirectory $runtimeDirectory
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg runtime verification failed.' }
}
finally {
    if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
        $resolvedTemporary = [IO.Path]::GetFullPath($temporaryDirectory)
        $systemTemporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $leaf = Split-Path -Leaf $resolvedTemporary
        if ($resolvedTemporary.StartsWith($systemTemporary, [StringComparison]::OrdinalIgnoreCase) -and
            $leaf.StartsWith('SharpShot-FFmpeg-', [StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
        }
        else {
            throw "Refusing to remove unexpected temporary path: $resolvedTemporary"
        }
    }
}
