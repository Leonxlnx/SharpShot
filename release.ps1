[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$desktopRoot = Join-Path $repoRoot 'desktop'
$releaseRoot = Join-Path $repoRoot 'artifacts\release'
$studioVersion = '0.2.0-alpha.1'
$quickVersion = '1.5.0'
$releaseTag = "studio-v$studioVersion"
$repositoryUrl = 'https://github.com/Leonxlnx/SharpShot'

. (Join-Path $repoRoot 'tools\safe-directory.ps1')
. (Join-Path $desktopRoot 'scripts\ffmpeg-compliance-policy.ps1')

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
    }
}

function Invoke-Git([string[]]$Arguments) {
    $result = @(& git -c "safe.directory=$repoRoot" @Arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: git $($Arguments -join ' ')"
    }
    return $result
}

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

$package = Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
$lockText = Get-Content -LiteralPath (Join-Path $desktopRoot 'package-lock.json') -Raw
$escapedStudioVersion = [Regex]::Escape($studioVersion)
$lockVersionPattern = (
    '(?s)^\s*\{\s*"name"\s*:\s*"sharpshot-studio"\s*,\s*' +
    '"version"\s*:\s*"' + $escapedStudioVersion + '".*?' +
    '"packages"\s*:\s*\{\s*""\s*:\s*\{\s*' +
    '"name"\s*:\s*"sharpshot-studio"\s*,\s*' +
    '"version"\s*:\s*"' + $escapedStudioVersion + '"'
)
if ($package.version -ne $studioVersion -or $lockText -notmatch $lockVersionPattern) {
    throw "Studio version must be $studioVersion in package.json and package-lock.json."
}

$repoTopLines = @(Invoke-Git @('rev-parse', '--show-toplevel'))
$repoTop = $repoTopLines[0]
if ([IO.Path]::GetFullPath($repoTop) -ne $repoRoot) {
    throw "release.ps1 must run from the SharpShot repository: $repoTop"
}
$status = @(Invoke-Git @('status', '--porcelain=v1', '--untracked-files=all'))
if ($status.Count -gt 0) {
    throw "Release requires a clean working tree. First change: $($status[0])"
}
$headTags = @(Invoke-Git @('tag', '--points-at', 'HEAD'))
if ($headTags -notcontains $releaseTag) {
    throw "HEAD must carry the exact release tag $releaseTag."
}
$commitLines = @(Invoke-Git @('rev-parse', 'HEAD'))
$commit = $commitLines[0]
$canonicalMediaManifestPath = Join-Path $desktopRoot 'resources\ffmpeg\win32-x64\runtime-manifest.json'
$canonicalMediaManifest = Get-Content -LiteralPath $canonicalMediaManifestPath -Raw | ConvertFrom-Json
$complianceProperty = $canonicalMediaManifest.PSObject.Properties['complianceStatus']
$mediaComplianceStatus = if ($null -eq $complianceProperty) { $null } else { [string]$complianceProperty.Value }
Assert-FfmpegComplianceStatus -Status $mediaComplianceStatus -PublicRelease

Write-Host "Building SharpShot Quick $quickVersion..."
& (Join-Path $repoRoot 'build.ps1')

Push-Location $desktopRoot
try {
    Invoke-Checked 'npm.cmd' @('ci')
    Invoke-Checked 'npm.cmd' @('audit', '--audit-level=high')
    Invoke-Checked 'npm.cmd' @('run', 'release:verify-static')
    Invoke-Checked 'npm.cmd' @('test')
    Invoke-Checked 'npm.cmd' @('run', 'media:vendor')
    Invoke-Checked 'npm.cmd' @('run', 'media:smoke')
    Invoke-Checked 'npm.cmd' @('run', 'package:win')
}
finally {
    Pop-Location
}

$studioZip = Join-Path $repoRoot "artifacts\desktop\SharpShot-Studio-$studioVersion-win-x64.zip"
$studioSetup = Join-Path $repoRoot "artifacts\desktop\SharpShot-Studio-Setup-$studioVersion-win-x64.exe"
$quickZip = Join-Path $repoRoot "artifacts\native\SharpShot-Quick-$quickVersion-win-x64.zip"
foreach ($asset in @($studioSetup, $studioZip, $quickZip)) {
    if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) {
        throw "Expected release asset is missing: $asset"
    }
}

& (Join-Path $desktopRoot 'scripts\verify-packaged-ffmpeg.ps1') `
    -PackagePath $studioZip `
    -RequireReleaseCompliance
Reset-SafeDirectoryExact `
    -TrustedRoot $repoRoot `
    -Path $releaseRoot `
    -RequiredRelativePath 'artifacts\release'
foreach ($asset in @($studioSetup, $studioZip, $quickZip)) {
    Copy-Item -LiteralPath $asset -Destination $releaseRoot
}

$packageRecords = @(
    [ordered]@{
        file = Split-Path -Leaf $studioSetup
        edition = 'Full Studio'
        kind = 'per-user installer'
        recommended = $true
        version = $studioVersion
        platform = 'win32-x64'
        authenticode = 'unsigned'
        bytes = (Get-Item -LiteralPath $studioSetup).Length
        sha256 = Get-LowerSha256 $studioSetup
    },
    [ordered]@{
        file = Split-Path -Leaf $studioZip
        edition = 'Full Studio'
        kind = 'portable ZIP'
        recommended = $false
        version = $studioVersion
        platform = 'win32-x64'
        authenticode = 'unsigned'
        bytes = (Get-Item -LiteralPath $studioZip).Length
        sha256 = Get-LowerSha256 $studioZip
    },
    [ordered]@{
        file = Split-Path -Leaf $quickZip
        edition = 'Quick Capture'
        kind = 'portable ZIP'
        recommended = $false
        version = $quickVersion
        platform = 'win32-x64'
        authenticode = 'unsigned'
        bytes = (Get-Item -LiteralPath $quickZip).Length
        sha256 = Get-LowerSha256 $quickZip
    }
)
$manifest = [ordered]@{
    schemaVersion = 1
    tag = $releaseTag
    prerelease = $true
    platform = 'win32-x64'
    source = [ordered]@{
        repository = $repositoryUrl
        commit = $commit
        license = "$repositoryUrl/blob/$releaseTag/LICENSE"
    }
    warning = 'Unsigned Windows prerelease. Verify SHA256SUMS.txt. Run either Full Studio or Quick Capture, never both simultaneously, because both own global shortcuts.'
    packagingNotes = @(
        'Built-in background masters ship once as runtime resources; the renderer bundle carries only the eight lightweight thumbnails.',
        'Artifacts are fully tested and hash-verified but are not claimed to be bit-for-bit reproducible across build machines.'
    )
    mediaRuntime = [ordered]@{
        component = 'FFmpeg'
        complianceStatus = $mediaComplianceStatus
        notice = 'desktop/resources/ffmpeg/win32-x64/THIRD_PARTY_NOTICES.md'
        complianceNotice = 'desktop/resources/ffmpeg/win32-x64/COMPLIANCE-BLOCKED.md'
    }
    packages = $packageRecords
}
$manifestPath = Join-Path $releaseRoot 'release-manifest.json'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) + "`n", $utf8NoBom)

$checksummedNames = @($packageRecords.file) + 'release-manifest.json'
$checksumLines = foreach ($name in $checksummedNames) {
    $assetPath = Join-Path $releaseRoot $name
    "$(Get-LowerSha256 $assetPath)  $name"
}
$checksumPath = Join-Path $releaseRoot 'SHA256SUMS.txt'
$checksumLines | Set-Content -LiteralPath $checksumPath -Encoding ascii

$expectedPackageNames = @(
    "SharpShot-Studio-Setup-$studioVersion-win-x64.exe",
    "SharpShot-Studio-$studioVersion-win-x64.zip",
    "SharpShot-Quick-$quickVersion-win-x64.zip"
) | Sort-Object
$expectedChecksumNames = @($expectedPackageNames + 'release-manifest.json') | Sort-Object
$expectedNames = @(
    $expectedChecksumNames + 'SHA256SUMS.txt'
) | Sort-Object
$actualNames = @(Get-ChildItem -LiteralPath $releaseRoot -File | ForEach-Object Name | Sort-Object)
if ($actualNames.Count -ne $expectedNames.Count -or (Compare-Object $expectedNames $actualNames)) {
    throw 'Release directory does not contain the exact five-file allowlist.'
}
$checksumFileLines = @(Get-Content -LiteralPath $checksumPath)
if ($checksumFileLines.Count -ne 4) {
    throw "SHA256SUMS.txt must contain exactly four non-self entries, found $($checksumFileLines.Count)."
}
$checksumEntries = foreach ($line in $checksumFileLines) {
    if ($line -notmatch '^([0-9a-f]{64})  ([^\\/]+)$') {
        throw "Invalid release checksum line: $line"
    }
    $entryName = $Matches[2]
    if ((Split-Path -Leaf $entryName) -cne $entryName -or $entryName -ceq 'SHA256SUMS.txt') {
        throw "Release checksums may contain only expected non-self leaf names: $entryName"
    }
    [pscustomobject]@{ name = $entryName; sha256 = $Matches[1] }
}
$checksumNames = @($checksumEntries | ForEach-Object name)
if (@($checksumNames | Sort-Object -Unique).Count -ne $checksumNames.Count -or
    (Compare-Object $expectedChecksumNames @($checksumNames | Sort-Object))) {
    throw 'SHA256SUMS.txt must contain each of the four expected names exactly once.'
}
foreach ($entry in $checksumEntries) {
    $assetPath = Join-Path $releaseRoot $entry.name
    if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf) -or
        (Get-LowerSha256 $assetPath) -cne $entry.sha256) {
        throw "Release checksum verification failed: $($entry.name)"
    }
}

$verifiedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($verifiedManifest.schemaVersion -ne 1 -or
    $verifiedManifest.tag -cne $releaseTag -or
    $verifiedManifest.platform -cne 'win32-x64' -or
    $verifiedManifest.prerelease -ne $true -or
    $verifiedManifest.source.repository -cne $repositoryUrl -or
    $verifiedManifest.source.commit -cne $commit -or
    $verifiedManifest.source.license -cne "$repositoryUrl/blob/$releaseTag/LICENSE" -or
    $verifiedManifest.mediaRuntime.component -cne 'FFmpeg' -or
    $verifiedManifest.mediaRuntime.complianceStatus -cne 'verified' -or
    $verifiedManifest.PSObject.Properties.Name -contains 'generatedAtUtc') {
    throw 'release-manifest.json has invalid tag, source, platform, prerelease, or deterministic-metadata fields.'
}
$verifiedPackages = @($verifiedManifest.packages)
$manifestPackageNames = @($verifiedPackages | ForEach-Object file)
if ($verifiedPackages.Count -ne 3 -or
    @($manifestPackageNames | Sort-Object -Unique).Count -ne 3 -or
    (Compare-Object $expectedPackageNames @($manifestPackageNames | Sort-Object))) {
    throw 'release-manifest.json must describe each of the three package assets exactly once.'
}
foreach ($packageRecord in $verifiedPackages) {
    $assetPath = Join-Path $releaseRoot $packageRecord.file
    $checksumEntry = @($checksumEntries | Where-Object name -CEQ $packageRecord.file)
    if ($checksumEntry.Count -ne 1 -or
        $packageRecord.platform -cne 'win32-x64' -or
        $packageRecord.authenticode -cne 'unsigned' -or
        [long]$packageRecord.bytes -ne (Get-Item -LiteralPath $assetPath).Length -or
        $packageRecord.sha256 -cne $checksumEntry[0].sha256 -or
        $packageRecord.sha256 -cne (Get-LowerSha256 $assetPath)) {
        throw "Manifest asset metadata does not match the verified file: $($packageRecord.file)"
    }
}

Write-Host "Verified release assets: $releaseRoot"
Get-ChildItem -LiteralPath $releaseRoot -File | Sort-Object Name | Select-Object Name, Length
