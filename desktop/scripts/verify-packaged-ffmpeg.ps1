[CmdletBinding()]
param(
    [string]$PackagePath,
    [switch]$LatestZip,
    [switch]$SmokeTest,
    [switch]$RequireReleaseCompliance
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..\artifacts\desktop'))
. (Join-Path $PSScriptRoot 'ffmpeg-compliance-policy.ps1')
$studioPackage = Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
$studioNumericVersion = [Version]($studioPackage.version -replace '-.*$', '')
$studioProductVersion = '{0}.{1}.{2}.0' -f @(
    $studioNumericVersion.Major,
    $studioNumericVersion.Minor,
    $studioNumericVersion.Build
)
$canonicalManifestPath = Join-Path $desktopRoot 'resources\ffmpeg\win32-x64\runtime-manifest.json'
if (-not (Test-Path -LiteralPath $canonicalManifestPath -PathType Leaf)) {
    throw "Canonical FFmpeg runtime manifest not found: $canonicalManifestPath"
}
$canonicalMediaManifest = Get-Content -LiteralPath $canonicalManifestPath -Raw | ConvertFrom-Json
Assert-FfmpegComplianceStatus `
    -Status $canonicalMediaManifest.complianceStatus `
    -PublicRelease:$RequireReleaseCompliance
$canonicalNativeManifestPath = Join-Path $desktopRoot 'resources\native\win32-x64\native-runtime-manifest.json'
if (-not (Test-Path -LiteralPath $canonicalNativeManifestPath -PathType Leaf)) {
    throw "Canonical native runtime manifest not found: $canonicalNativeManifestPath. Run npm run native:vendor."
}
$reactFamilyLicensePath = Join-Path $desktopRoot 'resources\licenses\REACT-FAMILY-MIT.txt'
$reactFamilyLicenseBytes = 1088
$reactFamilyLicenseSha256 = 'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'
if (-not (Test-Path -LiteralPath $reactFamilyLicensePath -PathType Leaf) -or
    (Get-Item -LiteralPath $reactFamilyLicensePath).Length -ne $reactFamilyLicenseBytes) {
    throw "Canonical React-family MIT license is missing or has the wrong byte count: $reactFamilyLicensePath"
}

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

function Assert-X64Pe([string]$Path) {
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
        if ($reader.ReadUInt16() -ne 0x8664) { throw "Packaged executable is not PE x64: $Path" }
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

if ((Get-Sha256 $reactFamilyLicensePath) -cne $reactFamilyLicenseSha256) {
    throw "Canonical React-family MIT license hash does not match the pinned 19.2.8/0.27.0 license text."
}

function Assert-PackagedCopy(
    [string]$SearchRoot,
    [string]$RelativeSuffix,
    [string]$CanonicalPath
) {
    $normalizedSuffix = $RelativeSuffix.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $matches = @(
        Get-ChildItem -LiteralPath $SearchRoot -Recurse -File |
            Where-Object {
                $_.FullName.EndsWith(
                    $normalizedSuffix,
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    if ($matches.Count -ne 1) {
        throw "Expected one packaged $RelativeSuffix, found $($matches.Count)."
    }
    if ((Get-Sha256 $matches[0].FullName) -ne (Get-Sha256 $CanonicalPath)) {
        throw "Packaged $RelativeSuffix differs from its canonical repository copy."
    }
}

function Assert-NoDevelopmentFiles([string]$SearchRoot) {
    $forbidden = @(
        Get-ChildItem -LiteralPath $SearchRoot -Recurse -File |
            Where-Object {
                $_.Extension -eq '.map' -or
                $_.Name -match '\.(test|spec)\.' -or
                $_.FullName -match '[\\/](test-results|tests?|renderer-browser|tactile|design-reference)([\\/]|$)'
            }
    )
    if ($forbidden.Count -gt 0) {
        throw "Packaged development files are forbidden: $($forbidden[0].FullName)"
    }
}

if ($LatestZip) {
    $package = Get-ChildItem -LiteralPath $artifactsRoot -File -Filter 'SharpShot-Studio-*-win-x64.zip' |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $package) { throw "No packaged SharpShot Studio ZIP found under $artifactsRoot." }
    $PackagePath = $package.FullName
}
if (-not $PackagePath) {
    throw 'Pass -PackagePath or -LatestZip.'
}
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$temporaryDirectory = $null
try {
    if (Test-Path -LiteralPath $resolvedPackage -PathType Leaf) {
        if ([IO.Path]::GetExtension($resolvedPackage) -ne '.zip') {
            throw "Only packaged ZIP files or unpacked directories are supported: $resolvedPackage"
        }
        $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) (
            'SharpShot-Package-Verify-' + [Guid]::NewGuid().ToString('N')
        )
        New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
        Expand-Archive -LiteralPath $resolvedPackage -DestinationPath $temporaryDirectory
        $searchRoot = $temporaryDirectory
    }
    else {
        $searchRoot = $resolvedPackage
    }

    $manifests = @(
        Get-ChildItem -LiteralPath $searchRoot -Recurse -File -Filter 'runtime-manifest.json' |
            Where-Object {
                $_.FullName -match '[\\/]resources[\\/]ffmpeg[\\/]win32-x64[\\/]runtime-manifest\.json$'
            }
    )
    if ($manifests.Count -ne 1) {
        throw "Expected one packaged FFmpeg manifest, found $($manifests.Count)."
    }
    $canonicalManifestHash = Get-Sha256 $canonicalManifestPath
    $packagedManifestHash = Get-Sha256 $manifests[0].FullName
    if ($packagedManifestHash -ne $canonicalManifestHash) {
        throw (
            "Packaged FFmpeg manifest differs from the canonical source manifest. " +
            "Packaged SHA-256: $packagedManifestHash; expected: $canonicalManifestHash."
        )
    }
    $packagedMediaManifest = Get-Content -LiteralPath $manifests[0].FullName -Raw | ConvertFrom-Json
    Assert-FfmpegComplianceStatus `
        -Status $packagedMediaManifest.complianceStatus `
        -PublicRelease:$RequireReleaseCompliance
    $runtimeDirectory = Split-Path -Parent $manifests[0].FullName
    $verifyScript = Join-Path $PSScriptRoot 'verify-ffmpeg.ps1'
    & $verifyScript -RuntimeDirectory $runtimeDirectory -SmokeTest:$SmokeTest
    if ($LASTEXITCODE -ne 0) { throw 'Packaged FFmpeg runtime verification failed.' }

    $nativeManifests = @(
        Get-ChildItem -LiteralPath $searchRoot -Recurse -File -Filter 'native-runtime-manifest.json' |
            Where-Object {
                $_.FullName -match '[\\/]resources[\\/]native[\\/]win32-x64[\\/]native-runtime-manifest\.json$'
            }
    )
    if ($nativeManifests.Count -ne 1) {
        throw "Expected one packaged native runtime manifest, found $($nativeManifests.Count)."
    }
    $canonicalNativeManifestHash = Get-Sha256 $canonicalNativeManifestPath
    $packagedNativeManifestHash = Get-Sha256 $nativeManifests[0].FullName
    . (Join-Path $PSScriptRoot 'native-build-common.ps1')
    $canonicalNativeRuntimeDirectory = Split-Path -Parent $canonicalNativeManifestPath
    Assert-NativeRuntime `
        -RuntimeDirectory $canonicalNativeRuntimeDirectory `
        -RepoRoot $repoRoot `
        -CheckSources | Out-Null
    if ($packagedNativeManifestHash -ne $canonicalNativeManifestHash) {
        throw (
            "Packaged native runtime manifest differs from the canonical source manifest. " +
            "Packaged SHA-256: $packagedNativeManifestHash; expected: $canonicalNativeManifestHash."
        )
    }
    $nativeRuntimeDirectory = Split-Path -Parent $nativeManifests[0].FullName
    Assert-NativeRuntime `
        -RuntimeDirectory $nativeRuntimeDirectory `
        -RepoRoot $repoRoot | Out-Null

    Assert-PackagedCopy `
        -SearchRoot $searchRoot `
        -RelativeSuffix 'resources/LICENSE' `
        -CanonicalPath (Join-Path $repoRoot 'LICENSE')
    Assert-PackagedCopy `
        -SearchRoot $searchRoot `
        -RelativeSuffix 'resources/THIRD_PARTY_ASSETS.md' `
        -CanonicalPath (Join-Path $repoRoot 'THIRD_PARTY_ASSETS.md')
    Assert-PackagedCopy `
        -SearchRoot $searchRoot `
        -RelativeSuffix 'resources/audio/LICENSE-CC0-1.0.txt' `
        -CanonicalPath (Join-Path $desktopRoot 'resources/audio/LICENSE-CC0-1.0.txt')
    Assert-PackagedCopy `
        -SearchRoot $searchRoot `
        -RelativeSuffix 'resources/licenses/REACT-FAMILY-MIT.txt' `
        -CanonicalPath $reactFamilyLicensePath

    foreach ($electronNotice in @('LICENSE.electron.txt', 'LICENSES.chromium.html')) {
        $noticeMatches = @(Get-ChildItem -LiteralPath $searchRoot -Recurse -File -Filter $electronNotice)
        if ($noticeMatches.Count -ne 1 -or $noticeMatches[0].Length -eq 0) {
            throw "Expected one non-empty packaged Electron notice: $electronNotice"
        }
    }

    Assert-NoDevelopmentFiles -SearchRoot $searchRoot

    $asarMatches = @(Get-ChildItem -LiteralPath $searchRoot -Recurse -File -Filter 'app.asar')
    if ($asarMatches.Count -ne 1) {
        throw "Expected one packaged app.asar, found $($asarMatches.Count)."
    }
    $asarCli = Join-Path $desktopRoot 'node_modules/@electron/asar/bin/asar.js'
    if (-not (Test-Path -LiteralPath $asarCli -PathType Leaf)) {
        throw "The pinned @electron/asar verifier is missing. Run npm ci: $asarCli"
    }
    $asarEntries = @(& node $asarCli list $asarMatches[0].FullName)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect packaged app.asar.' }
    $forbiddenAsarEntry = $asarEntries | Where-Object {
        $_ -match '(^|[\\/])(tests?|test-results|renderer-browser|tactile|design-reference)([\\/]|$)' -or
        $_ -match '\.map$' -or
        $_ -match '\.(test|spec)\.'
    } | Select-Object -First 1
    if ($forbiddenAsarEntry) {
        throw "Packaged app.asar contains a forbidden development entry: $forbiddenAsarEntry"
    }

    $studioExecutables = @(Get-ChildItem -LiteralPath $searchRoot -Recurse -File -Filter 'SharpShot Studio.exe')
    if ($studioExecutables.Count -ne 1) {
        throw "Expected one packaged SharpShot Studio.exe, found $($studioExecutables.Count)."
    }
    $studioExecutable = $studioExecutables[0].FullName
    Assert-X64Pe $studioExecutable
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($studioExecutable)
    if ($versionInfo.FileMajorPart -ne $studioNumericVersion.Major -or
        $versionInfo.FileMinorPart -ne $studioNumericVersion.Minor -or
        $versionInfo.FileBuildPart -ne $studioNumericVersion.Build -or
        $versionInfo.FileVersion -cne $studioPackage.version -or
        $versionInfo.ProductVersion -cne $studioProductVersion -or
        $versionInfo.ProductName -cne 'SharpShot Studio') {
        throw "Packaged Studio executable version does not match $($studioPackage.version): $($versionInfo.FileVersion)"
    }
    $studioSignature = Get-AuthenticodeSignature -LiteralPath $studioExecutable
    if ($studioSignature.Status -ne [Management.Automation.SignatureStatus]::NotSigned) {
        throw "Expected unsigned Studio executable, found Authenticode status $($studioSignature.Status)."
    }

    Write-Output "Packaged runtimes, legal notices, and production-only contents verified in $resolvedPackage"
}
finally {
    if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
        $resolvedTemporary = [IO.Path]::GetFullPath($temporaryDirectory)
        $systemTemporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $leaf = Split-Path -Leaf $resolvedTemporary
        if ($resolvedTemporary.StartsWith($systemTemporary, [StringComparison]::OrdinalIgnoreCase) -and
            $leaf.StartsWith('SharpShot-Package-Verify-', [StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
        }
        else {
            throw "Refusing to remove unexpected package-verification path: $resolvedTemporary"
        }
    }
}
