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
$portableRoot = Join-Path $artifactsRoot 'SharpShot'
$version = '1.1.0'

function Reset-RepoDirectory([string]$path) {
    $fullPath = [IO.Path]::GetFullPath($path)
    $requiredPrefix = $repoRoot.TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a directory outside the repository: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
}

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw 'The .NET Framework C# compiler was not found. Install .NET Framework 4.8 Developer Pack.'
}

Reset-RepoDirectory $buildRoot
Reset-RepoDirectory $artifactsRoot
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
    "$sourceRoot\SharpShot.cs"
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
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
        "$hash  $($_.Name)"
    }
$checksumLines | Set-Content -LiteralPath "$portableRoot\SHA256SUMS.txt" -Encoding ascii

$zipPath = Join-Path $artifactsRoot "SharpShot-v$version-win-x64.zip"
Compress-Archive -LiteralPath $portableRoot -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
$checksumPath = "$zipPath.sha256.txt"
"$zipHash  $(Split-Path -Leaf $zipPath)" | Set-Content -LiteralPath $checksumPath -Encoding ascii

Write-Host "Built: $zipPath"
Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath | Format-List Path, Hash
