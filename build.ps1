[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$sourceRoot = Join-Path $repoRoot 'src\SharpShot'
$toolsRoot = Join-Path $repoRoot 'tools'
$buildRoot = Join-Path $repoRoot 'build'
$artifactsRoot = Join-Path $repoRoot 'artifacts'
$nativeArtifactsRoot = Join-Path $artifactsRoot 'native'
$portableRoot = Join-Path $nativeArtifactsRoot 'SharpShot'
$version = '1.5.0'

. (Join-Path $toolsRoot 'safe-directory.ps1')

function Get-UpperSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$sourceText = Get-Content -LiteralPath (Join-Path $sourceRoot 'SharpShot.cs') -Raw
$sharpShotSources = @(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.cs' -File |
    Sort-Object Name |
    ForEach-Object FullName)
$manifestText = Get-Content -LiteralPath (Join-Path $sourceRoot 'app.manifest') -Raw
$changelogText = Get-Content -LiteralPath (Join-Path $repoRoot 'CHANGELOG.md') -Raw
if (-not $sourceText.Contains("AssemblyVersion(`"$version.0`")") -or
    -not $sourceText.Contains("AssemblyFileVersion(`"$version.0`")") -or
    -not $sourceText.Contains("SharpShot $version\n\n") -or
    -not $manifestText.Contains("version=`"$version.0`"") -or
    -not $changelogText.Contains("## $version ")) {
    throw "Version $version is not synchronized across source, manifest, About text, and changelog."
}

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw 'The .NET Framework C# compiler was not found. Install .NET Framework 4.8 Developer Pack.'
}

Reset-SafeDirectoryExact -TrustedRoot $repoRoot -Path $buildRoot -RequiredRelativePath 'build'
Reset-SafeDirectoryExact `
    -TrustedRoot $repoRoot `
    -Path $nativeArtifactsRoot `
    -RequiredRelativePath 'artifacts\native'
New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null

& $csc /nologo /target:exe /optimize+ /warn:4 `
    /reference:System.dll `
    /reference:System.Drawing.dll `
    /out:"$buildRoot\GenerateIcon.exe" `
    "$toolsRoot\GenerateIcon.cs"
if ($LASTEXITCODE -ne 0) { throw 'Icon generator compilation failed.' }

& "$buildRoot\GenerateIcon.exe" "$buildRoot\SharpShot.ico"
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }

& $csc /nologo /target:winexe /optimize+ /warn:4 /platform:x64 `
    /win32manifest:"$sourceRoot\app.manifest" `
    /win32icon:"$buildRoot\SharpShot.ico" `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /out:"$portableRoot\SharpShot.exe" `
    $sharpShotSources
if ($LASTEXITCODE -ne 0) { throw 'SharpShot compilation failed.' }

Copy-Item -LiteralPath "$sourceRoot\SharpShot.exe.config" -Destination "$portableRoot\SharpShot.exe.config"
Copy-Item -LiteralPath "$repoRoot\README.md" -Destination "$portableRoot\README.md"
Copy-Item -LiteralPath "$repoRoot\LICENSE" -Destination "$portableRoot\LICENSE"

if (-not $SkipTests) {
    $testRoot = Join-Path $buildRoot 'self-test'
    $testProcess = Start-Process `
        -FilePath "$portableRoot\SharpShot.exe" `
        -ArgumentList @('--self-test', ('"' + $testRoot + '"')) `
        -Wait -PassThru -WindowStyle Hidden
    if ($testProcess.ExitCode -ne 0) {
        if (Test-Path -LiteralPath "$testRoot\self-test.txt") {
            Get-Content -LiteralPath "$testRoot\self-test.txt"
        }
        throw "SharpShot self-test failed with exit code $($testProcess.ExitCode)."
    }
    Get-Content -LiteralPath "$testRoot\self-test.txt"
}

$checksumLines = Get-ChildItem -LiteralPath $portableRoot -File |
    Sort-Object Name |
    ForEach-Object {
        $hash = Get-UpperSha256 $_.FullName
        "$hash  $($_.Name)"
    }
$checksumLines | Set-Content -LiteralPath "$portableRoot\SHA256SUMS.txt" -Encoding ascii

$zipPath = Join-Path $nativeArtifactsRoot "SharpShot-Quick-$version-win-x64.zip"
Compress-Archive -LiteralPath $portableRoot -DestinationPath $zipPath -CompressionLevel Optimal

$verifyRoot = Join-Path $buildRoot 'package-verify'
New-Item -ItemType Directory -Path $verifyRoot -Force | Out-Null
Expand-Archive -LiteralPath $zipPath -DestinationPath $verifyRoot
$verifiedPortableRoot = Join-Path $verifyRoot 'SharpShot'
$expectedNames = @('LICENSE', 'README.md', 'SHA256SUMS.txt', 'SharpShot.exe', 'SharpShot.exe.config')
$actualNames = @(Get-ChildItem -LiteralPath $verifiedPortableRoot -File | Sort-Object Name | ForEach-Object Name)
if ($actualNames.Count -ne $expectedNames.Count -or (Compare-Object $expectedNames $actualNames)) {
    throw 'The portable ZIP does not contain the exact expected file set.'
}
foreach ($line in Get-Content -LiteralPath (Join-Path $verifiedPortableRoot 'SHA256SUMS.txt')) {
    $parts = $line -split '  ', 2
    if ($parts.Count -ne 2) { throw "Invalid inner checksum line: $line" }
    $verifiedFile = Join-Path $verifiedPortableRoot $parts[1]
    if (-not (Test-Path -LiteralPath $verifiedFile)) { throw "Checksummed file is missing: $($parts[1])" }
    $actualHash = Get-UpperSha256 $verifiedFile
    if ($actualHash -ne $parts[0]) { throw "Inner checksum mismatch: $($parts[1])" }
}

if (-not $SkipTests) {
    $packagedTestRoot = Join-Path $buildRoot 'packaged-self-test'
    $packagedTest = Start-Process `
        -FilePath (Join-Path $verifiedPortableRoot 'SharpShot.exe') `
        -ArgumentList @('--self-test', ('"' + $packagedTestRoot + '"')) `
        -Wait -PassThru -WindowStyle Hidden
    if ($packagedTest.ExitCode -ne 0) {
        throw "Packaged SharpShot self-test failed with exit code $($packagedTest.ExitCode)."
    }
}

$zipHash = Get-UpperSha256 $zipPath
$checksumPath = "$zipPath.sha256.txt"
"$zipHash  $(Split-Path -Leaf $zipPath)" | Set-Content -LiteralPath $checksumPath -Encoding ascii

Write-Host "Built: $zipPath"
Write-Host "SHA-256: $zipHash"
