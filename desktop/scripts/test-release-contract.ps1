[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$studioVersion = '0.2.0-alpha.1'
$quickVersion = '1.5.0'

function Assert-Contains([string]$Text, [string]$Needle, [string]$Label) {
    if (-not $Text.Contains($Needle)) {
        throw "$Label is missing required release contract: $Needle"
    }
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

foreach ($scriptPath in @(
    (Join-Path $repoRoot 'build.ps1'),
    (Join-Path $repoRoot 'release.ps1'),
    (Join-Path $repoRoot 'tools\safe-directory.ps1'),
    (Join-Path $PSScriptRoot 'verify-packaged-ffmpeg.ps1'),
    (Join-Path $PSScriptRoot 'verify-studio-setup.ps1'),
    (Join-Path $PSScriptRoot 'test-safe-directory.ps1')
)) {
    $tokens = $null
    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile(
        $scriptPath,
        [ref]$tokens,
        [ref]$parseErrors
    ) | Out-Null
    if ($parseErrors.Count -gt 0) {
        throw "PowerShell syntax error in $scriptPath`: $($parseErrors[0].Message)"
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
    throw "Studio package versions must all equal $studioVersion."
}

$builder = Get-Content -LiteralPath (Join-Path $desktopRoot 'electron-builder.yml') -Raw
foreach ($required in @(
    '  - out/main/**/*',
    '  - out/preload/**/*',
    '  - out/renderer/**/*',
    '  - from: ../LICENSE',
    '  - from: ../THIRD_PARTY_ASSETS.md'
)) {
    Assert-Contains $builder $required 'electron-builder.yml'
}
if ($builder -match '(?m)^\s*- out/\*\*/\*\s*$') {
    throw 'electron-builder.yml must not package stale out directories.'
}

$nativeBuild = Get-Content -LiteralPath (Join-Path $repoRoot 'build.ps1') -Raw
Assert-Contains $nativeBuild "SharpShot-Quick-`$version-win-x64.zip" 'build.ps1'
Assert-Contains $nativeBuild "Join-Path `$artifactsRoot 'native'" 'build.ps1'
Assert-Contains $nativeBuild 'Reset-SafeDirectoryExact' 'build.ps1'
Assert-Contains $nativeBuild 'toolsRoot ''safe-directory.ps1''' 'build.ps1'
if ($nativeBuild.Contains('Reset-RepoDirectory $artifactsRoot')) {
    throw 'build.ps1 must not reset the shared artifacts root.'
}

$release = Get-Content -LiteralPath (Join-Path $repoRoot 'release.ps1') -Raw
foreach ($required in @(
    "studio-v`$studioVersion",
    'npm.cmd'' @(''audit'', ''--audit-level=high'')',
    'npm.cmd'' @(''test'')',
    'npm.cmd'' @(''run'', ''media:smoke'')',
    'npm.cmd'' @(''run'', ''package:win'')',
    'SHA256SUMS.txt',
    'release-manifest.json',
    "platform = 'win32-x64'",
    "authenticode = 'unsigned'",
    'checksumFileLines.Count -ne 4',
    'verifiedManifest.source.commit -cne $commit',
    'Reset-SafeDirectoryExact'
)) {
    Assert-Contains $release $required 'release.ps1'
}
if ($release -match '(?i)skiptests') {
    throw 'release.ps1 must not expose or invoke a skip-tests path.'
}
if ($release -match '(?m)^\s*generatedAtUtc\s*=') {
    throw 'release.ps1 manifest metadata must not include a generated timestamp.'
}
if ($release.Contains('correspondingSources')) {
    throw 'release.ps1 must not present partial FFmpeg provenance as complete corresponding source.'
}

$verifier = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'verify-packaged-ffmpeg.ps1') -Raw
foreach ($required in @(
    'resources/LICENSE',
    'resources/THIRD_PARTY_ASSETS.md',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'resources/licenses/REACT-FAMILY-MIT.txt',
    'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93',
    'Assert-X64Pe',
    'SignatureStatus]::NotSigned',
    'renderer-browser',
    '\.map$'
)) {
    Assert-Contains $verifier $required 'verify-packaged-ffmpeg.ps1'
}

$reactLicense = Join-Path $desktopRoot 'resources\licenses\REACT-FAMILY-MIT.txt'
$reactLicenseHash = Get-LowerSha256 $reactLicense
if ((Get-Item -LiteralPath $reactLicense).Length -ne 1088 -or
    $reactLicenseHash -cne 'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93') {
    throw 'Checked-in React-family MIT license bytes do not match the pinned upstream license.'
}
foreach ($module in @('react', 'react-dom', 'scheduler')) {
    $upstreamLicense = Join-Path $desktopRoot "node_modules/$module/LICENSE"
    if ((Get-LowerSha256 $upstreamLicense) -cne
        $reactLicenseHash) {
        throw "Checked-in React-family MIT license differs from node_modules/$module/LICENSE."
    }
}

$setupVerifier = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'verify-studio-setup.ps1') -Raw
foreach ($required in @(
    '0x014c',
    '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3',
    'SignatureStatus]::NotSigned',
    'Type = 7z',
    'Offset = [1-9][0-9]*',
    'Path = SharpShot Studio.exe',
    'verify-packaged-ffmpeg.ps1',
    'Remove-SafeDirectoryExact'
)) {
    Assert-Contains $setupVerifier $required 'verify-studio-setup.ps1'
}
if (-not $package.scripts.'package:win'.Contains('npm run setup:verify')) {
    throw 'package:win must verify the generated NSIS Setup payload.'
}

foreach ($workflowName in @('build.yml', 'release.yml', 'quick-release.yml')) {
    $workflowPath = Join-Path $repoRoot ".github/workflows/$workflowName"
    $workflow = Get-Content -LiteralPath $workflowPath -Raw
    $actionReferences = [Regex]::Matches($workflow, '(?m)^\s*uses:\s*[^@\s]+@([^\s#]+)')
    if ($actionReferences.Count -eq 0) {
        throw "$workflowName does not reference any Actions."
    }
    foreach ($reference in $actionReferences) {
        if ($reference.Groups[1].Value -notmatch '^[0-9a-f]{40}$') {
            throw "$workflowName contains an Action that is not pinned to a full commit SHA: $($reference.Value.Trim())"
        }
    }

    $workflowLines = @(Get-Content -LiteralPath $workflowPath)
    for ($lineIndex = 0; $lineIndex -lt $workflowLines.Count; $lineIndex++) {
        if ($workflowLines[$lineIndex] -notmatch '^(\s*)run:\s*\|\s*$') { continue }
        $runIndent = $Matches[1].Length
        $scriptLines = New-Object Collections.Generic.List[string]
        for ($scriptIndex = $lineIndex + 1; $scriptIndex -lt $workflowLines.Count; $scriptIndex++) {
            $candidate = $workflowLines[$scriptIndex]
            if ($candidate.Trim().Length -gt 0) {
                $leading = $candidate.Length - $candidate.TrimStart().Length
                if ($leading -le $runIndent) { break }
            }
            $remove = [Math]::Min($candidate.Length, $runIndent + 2)
            $scriptLines.Add($candidate.Substring($remove))
        }
        $tokens = $null
        $parseErrors = $null
        [Management.Automation.Language.Parser]::ParseInput(
            ($scriptLines -join "`n"),
            [ref]$tokens,
            [ref]$parseErrors
        ) | Out-Null
        if ($parseErrors.Count -gt 0) {
            throw "PowerShell syntax error in $workflowName run block: $($parseErrors[0].Message)"
        }
    }
}

$releaseWorkflow = Get-Content -LiteralPath (Join-Path $repoRoot '.github/workflows/release.yml') -Raw
foreach ($required in @(
    'studio-v*',
    'permissions:',
    'contents: read',
    'contents: write',
    'gh release create',
    '--verify-tag --draft --prerelease --latest=false',
    'GH_REPO:',
    'EXPECTED_RELEASE_TAG: studio-v0.2.0-alpha.1',
    '$manifest.source.commit -cne $remoteCommit',
    '$manifest.mediaRuntime.complianceStatus -cne ''verified''',
    '$checksumLines.Count -ne 4'
)) {
    Assert-Contains $releaseWorkflow $required 'release.yml'
}
if ($releaseWorkflow.Contains('Exact corresponding source:')) {
    throw 'release.yml release notes must not overclaim the incomplete FFmpeg source inventory.'
}

$quickWorkflow = Get-Content -LiteralPath (Join-Path $repoRoot '.github/workflows/quick-release.yml') -Raw
foreach ($required in @(
    'EXPECTED_RELEASE_TAG: v1.5.0',
    'GH_REPO:',
    'Build and self-test Quick Capture',
    'FFmpeg-free Quick artifact',
    'SharpShot-Quick-1.5.0-win-x64.zip.sha256.txt',
    '--verify-tag --draft --prerelease --latest=false',
    'contents: read',
    'contents: write'
)) {
    Assert-Contains $quickWorkflow $required 'quick-release.yml'
}

foreach ($required in @(
    'RequireReleaseCompliance',
    'ffmpeg-compliance-policy.ps1',
    'Assert-FfmpegComplianceStatus -Status $mediaComplianceStatus -PublicRelease'
)) {
    Assert-Contains $release $required 'release.ps1'
}

$releasingGuide = Get-Content -LiteralPath (Join-Path $repoRoot 'RELEASING.md') -Raw
foreach ($required in @(
    'blocked-incomplete-third-party-inventory',
    '.\build.ps1',
    'npm run package:win',
    '.github/workflows/quick-release.yml',
    'v1.5.0'
)) {
    Assert-Contains $releasingGuide $required 'RELEASING.md'
}

& (Join-Path $PSScriptRoot 'test-ffmpeg-compliance-contract.ps1')
& (Join-Path $PSScriptRoot 'test-safe-directory.ps1')

Write-Output "Release contract verified for Studio $studioVersion and Quick $quickVersion."
