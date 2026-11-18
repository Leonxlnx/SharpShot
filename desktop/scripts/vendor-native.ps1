[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'native-build-common.ps1')

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$sourceRoot = Join-Path $repoRoot 'src\SharpShot'
$toolsRoot = Join-Path $repoRoot 'tools'
$stagingRoot = Join-Path $desktopRoot '.staging'
$runtimeParent = Join-Path $desktopRoot 'resources\native'
$runtimeDirectory = Join-Path $runtimeParent 'win32-x64'
$operationId = [Guid]::NewGuid().ToString('N')
$stagingDirectory = Join-Path $stagingRoot ('native-vendor-' + $operationId)
$compileDirectory = Join-Path $stagingDirectory 'compile'
$selfTestDirectory = Join-Path $stagingDirectory 'self-test'
$publishDirectory = Join-Path $stagingDirectory 'publish'
$backupDirectory = Join-Path $stagingDirectory 'previous-runtime'

function Assert-NoReparseTree([string]$Path) {
    $pending = New-Object Collections.Generic.Stack[string]
    $pending.Push([IO.Path]::GetFullPath($Path))
    while ($pending.Count -gt 0) {
        $currentPath = $pending.Pop()
        $current = Get-Item -LiteralPath $currentPath -Force
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to traverse a reparse point: $($current.FullName)"
        }
        if (-not $current.PSIsContainer) { continue }
        foreach ($child in Get-ChildItem -LiteralPath $current.FullName -Force) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to traverse a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Assert-NoReparsePathComponents([string]$TrustedRoot, [string]$Path) {
    $rootFullPath = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd('\')
    $pathFullPath = [IO.Path]::GetFullPath($Path)
    $rootPrefix = $rootFullPath + '\'
    if (-not $pathFullPath.Equals($rootFullPath, [StringComparison]::OrdinalIgnoreCase) -and
        -not $pathFullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside its trusted root: $pathFullPath"
    }
    $rootItem = Get-Item -LiteralPath $rootFullPath -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Trusted root is a reparse point: $rootFullPath"
    }
    $currentPath = $rootFullPath
    $relativePath = $pathFullPath.Substring($rootFullPath.Length).TrimStart('\')
    foreach ($segment in @($relativePath.Split('\') | Where-Object { $_.Length -gt 0 })) {
        $currentPath = Join-Path $currentPath $segment
        if (-not (Test-Path -LiteralPath $currentPath)) { continue }
        $item = Get-Item -LiteralPath $currentPath -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Path component is a reparse point: $($item.FullName)"
        }
    }
}

function Remove-SafeDirectory([string]$Path, [string]$Parent, [string]$RequiredLeafPrefix) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $leaf = Split-Path -Leaf $resolvedPath
    if (-not $resolvedPath.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith($RequiredLeafPrefix, [StringComparison]::Ordinal)) {
        throw "Refusing to remove unexpected native staging path: $resolvedPath"
    }
    Assert-NoReparsePathComponents $desktopRoot $Parent
    Assert-NoReparseTree $resolvedPath
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Assert-RecoverableNativeRuntime([string]$Path) {
    $runtimeRoot = [IO.Path]::GetFullPath($Path)
    Assert-NoReparseTree $runtimeRoot
    $actualNames = @(
        Get-ChildItem -LiteralPath $runtimeRoot -File -Force |
            Sort-Object Name |
            ForEach-Object { $_.Name }
    )
    $directories = @(
        Get-ChildItem -LiteralPath $runtimeRoot -Force |
            Where-Object { $_.PSIsContainer }
    )
    if ($directories.Count -gt 0) {
        throw "Interrupted native runtime contains directories: $runtimeRoot"
    }
    $legacyNames = @('SharpShot.Native.exe', 'SharpShot.Native.exe.config') | Sort-Object
    $manifestNames = @(
        'SharpShot.Native.exe',
        'SharpShot.Native.exe.config',
        'native-runtime-manifest.json'
    ) | Sort-Object
    $actualKey = $actualNames -join "`n"
    if ($actualKey -cne ($legacyNames -join "`n") -and
        $actualKey -cne ($manifestNames -join "`n")) {
        throw "Interrupted native runtime has an unexpected file set: $runtimeRoot"
    }
    $executable = Join-Path $runtimeRoot 'SharpShot.Native.exe'
    $config = Join-Path $runtimeRoot 'SharpShot.Native.exe.config'
    if ((Get-Item -LiteralPath $config).Length -lt 1) {
        throw "Interrupted native runtime config is empty: $config"
    }
    Assert-NativeX64Pe $executable
    Assert-NativeVersion $executable
    $manifestPath = Join-Path $runtimeRoot 'native-runtime-manifest.json'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        Assert-NativeRuntime -RuntimeDirectory $runtimeRoot -RepoRoot $repoRoot | Out-Null
    }
}

function Restore-InterruptedNativeRuntime() {
    if (Test-Path -LiteralPath $runtimeDirectory) { return }
    if (-not (Test-Path -LiteralPath $stagingRoot -PathType Container)) { return }
    $candidates = @(
        Get-ChildItem -LiteralPath $stagingRoot -Directory -Force |
            Where-Object { $_.Name.StartsWith('native-vendor-', [StringComparison]::Ordinal) } |
            ForEach-Object {
                if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Interrupted native runtime operation is a reparse point: $($_.FullName)"
                }
                $previousRuntime = Join-Path $_.FullName 'previous-runtime'
                if (Test-Path -LiteralPath $previousRuntime -PathType Container) {
                    $previousItem = Get-Item -LiteralPath $previousRuntime -Force
                    if (($previousItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw "Interrupted previous runtime is a reparse point: $previousRuntime"
                    }
                    [pscustomobject]@{
                        operationDirectory = $_.FullName
                        previousRuntime = $previousRuntime
                        lastWriteTimeUtc = (Get-Item -LiteralPath $previousRuntime).LastWriteTimeUtc
                    }
                }
            } |
            Sort-Object lastWriteTimeUtc -Descending
    )
    if ($candidates.Count -eq 0) { return }

    $recoveryErrors = New-Object Collections.Generic.List[string]
    foreach ($candidate in $candidates) {
        try {
            $operationItem = Get-Item -LiteralPath $candidate.operationDirectory -Force
            $previousItem = Get-Item -LiteralPath $candidate.previousRuntime -Force
            if (($operationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ($previousItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Interrupted native runtime recovery candidate is a reparse point.'
            }
            Assert-RecoverableNativeRuntime $candidate.previousRuntime
            New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
            Move-Item -LiteralPath $candidate.previousRuntime -Destination $runtimeDirectory
            try {
                Remove-SafeDirectory $candidate.operationDirectory $stagingRoot 'native-vendor-'
            }
            catch {
                Write-Warning (
                    'Recovered the native runtime, but could not remove its old staging directory: ' +
                    $_.Exception.Message
                )
            }
            Write-Warning 'Recovered the last-good native runtime from an interrupted directory swap.'
            return
        }
        catch {
            $recoveryErrors.Add("$($candidate.previousRuntime): $($_.Exception.Message)")
        }
    }
    throw (
        'The native runtime is missing and no interrupted-swap backup passed recovery checks. ' +
        ($recoveryErrors -join ' | ')
    )
}

$vendorMutex = New-Object Threading.Mutex(
    $false,
    'Local\SharpShotStudio_NativeVendor_8A543D6A_0A97_4A50_A10D_C8BFDB78DA2F'
)
$vendorMutexHeld = $false
try {
    try {
        $vendorMutexHeld = $vendorMutex.WaitOne(300000)
    }
    catch [Threading.AbandonedMutexException] {
        $vendorMutexHeld = $true
    }
    if (-not $vendorMutexHeld) {
        throw 'Timed out waiting five minutes for another native vendoring operation to finish.'
    }

Assert-NoReparsePathComponents $desktopRoot $stagingRoot
Assert-NoReparsePathComponents $desktopRoot $runtimeParent
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
Assert-NoReparsePathComponents $desktopRoot $stagingRoot
Assert-NoReparsePathComponents $desktopRoot $runtimeParent
Restore-InterruptedNativeRuntime

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) {
    throw 'The .NET Framework C# compiler was not found. Install the .NET Framework 4.8 Developer Pack.'
}

New-Item -ItemType Directory -Path $compileDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $publishDirectory -Force | Out-Null
$sourceStateBefore = @(Get-NativeSourceEntries $repoRoot)
$sourceFingerprintBefore = Get-NativeSourceFingerprint $sourceStateBefore
$sourceObservationBefore = Get-NativeSourceObservationFingerprint $sourceStateBefore
$compileContract = Get-NativeCompileContract
$publishCommitted = $false
$preserveStaging = $false

try {
    $generateIcon = Join-Path $compileDirectory 'GenerateIcon.exe'
    $iconPath = Join-Path $compileDirectory 'SharpShot.ico'
    $compiledExecutable = Join-Path $compileDirectory 'SharpShot.exe'
    $compiledConfig = Join-Path $compileDirectory 'SharpShot.exe.config'

    $iconCompilerArguments = @(
        '/nologo', '/target:exe', '/optimize+', '/warn:4',
        '/reference:System.dll', '/reference:System.Drawing.dll',
        ("/out:$generateIcon"), (Join-Path $toolsRoot 'GenerateIcon.cs')
    )
    & $csc @iconCompilerArguments
    if ($LASTEXITCODE -ne 0) { throw 'Native icon generator compilation failed.' }

    & $generateIcon $iconPath
    if ($LASTEXITCODE -ne 0) { throw 'Native icon generation failed.' }

    $applicationArguments = @(
        '/nologo', '/target:winexe', '/optimize+', '/warn:4', '/platform:x64',
        ("/win32manifest:" + (Join-Path $sourceRoot 'app.manifest')),
        ("/win32icon:$iconPath"),
        '/reference:System.dll', '/reference:System.Core.dll',
        '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
        ("/out:$compiledExecutable")
    ) + @(Get-NativeCompileSources $repoRoot)
    & $csc @applicationArguments
    if ($LASTEXITCODE -ne 0) { throw 'SharpShot native helper compilation failed.' }
    Assert-NativeX64Pe $compiledExecutable

    Copy-Item -LiteralPath (Join-Path $sourceRoot 'SharpShot.exe.config') -Destination $compiledConfig
    New-Item -ItemType Directory -Path $selfTestDirectory -Force | Out-Null
    $testProcess = Start-Process `
        -FilePath $compiledExecutable `
        -ArgumentList @('--self-test', ('"' + $selfTestDirectory + '"')) `
        -PassThru -WindowStyle Hidden
    try {
        if (-not $testProcess.WaitForExit(120000)) {
            $testProcess.Kill()
            $testProcess.WaitForExit()
            throw 'SharpShot native helper self-test timed out after 120 seconds.'
        }
        $selfTestExitCode = $testProcess.ExitCode
    }
    finally {
        $testProcess.Dispose()
    }
    $selfTestReport = Join-Path $selfTestDirectory 'self-test.txt'
    if ($selfTestExitCode -ne 0) {
        if (Test-Path -LiteralPath $selfTestReport -PathType Leaf) {
            Get-Content -LiteralPath $selfTestReport
        }
        throw "SharpShot native helper self-test failed with exit code $selfTestExitCode."
    }
    if (-not (Test-Path -LiteralPath $selfTestReport -PathType Leaf)) {
        throw 'SharpShot native helper self-test did not create self-test.txt.'
    }
    $reportLines = @(Get-Content -LiteralPath $selfTestReport)
    if ($reportLines.Count -eq 0 -or $reportLines[$reportLines.Count - 1] -cne 'RESULT: PASS') {
        throw 'SharpShot native helper self-test did not end with RESULT: PASS.'
    }

    $sourceStateAfter = @(Get-NativeSourceEntries $repoRoot)
    $sourceFingerprintAfter = Get-NativeSourceFingerprint $sourceStateAfter
    $sourceObservationAfter = Get-NativeSourceObservationFingerprint $sourceStateAfter
    if ($sourceFingerprintAfter -cne $sourceFingerprintBefore -or
        $sourceObservationAfter -cne $sourceObservationBefore) {
        throw 'Native source changed during compilation or self-test; refusing to publish a stale helper.'
    }

    $publishedExecutable = Join-Path $publishDirectory 'SharpShot.Native.exe'
    $publishedConfig = Join-Path $publishDirectory 'SharpShot.Native.exe.config'
    Copy-Item -LiteralPath $compiledExecutable -Destination $publishedExecutable
    Copy-Item -LiteralPath $compiledConfig -Destination $publishedConfig

    $compilerItem = Get-Item -LiteralPath $csc
    $executableItem = Get-Item -LiteralPath $publishedExecutable
    $configItem = Get-Item -LiteralPath $publishedConfig
    $manifest = [ordered]@{
        schemaVersion = 1
        runtime = 'SharpShot.Native'
        platform = 'win32-x64'
        version = Get-NativeExpectedVersion
        builtAtUtc = [DateTime]::UtcNow.ToString('O')
        sourceFingerprintSha256 = $sourceFingerprintAfter
        sources = $sourceStateAfter
        compile = [ordered]@{
            contract = $compileContract
            contractSha256 = Get-NativeStringSha256 $compileContract
            compilerPath = $csc
            compilerFileVersion = [string]$compilerItem.VersionInfo.FileVersion
            compilerSha256 = Get-NativeSha256 $csc
        }
        selfTest = [ordered]@{
            mode = '--self-test'
            result = 'PASS'
            reportSha256 = Get-NativeSha256 $selfTestReport
        }
        outputs = @(
            [ordered]@{
                name = 'SharpShot.Native.exe'
                bytes = [Int64]$executableItem.Length
                sha256 = Get-NativeSha256 $publishedExecutable
            },
            [ordered]@{
                name = 'SharpShot.Native.exe.config'
                bytes = [Int64]$configItem.Length
                sha256 = Get-NativeSha256 $publishedConfig
            }
        )
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 8
    $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText(
        (Join-Path $publishDirectory 'native-runtime-manifest.json'),
        $manifestJson + "`n",
        $utf8WithoutBom
    )
    Assert-NativeRuntime -RuntimeDirectory $publishDirectory -RepoRoot $repoRoot -CheckSources | Out-Null

    New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
    if (Test-Path -LiteralPath $runtimeDirectory) {
        Assert-NoReparseTree $runtimeDirectory
        Move-Item -LiteralPath $runtimeDirectory -Destination $backupDirectory
    }
    try {
        Move-Item -LiteralPath $publishDirectory -Destination $runtimeDirectory
    }
    catch {
        if (-not (Test-Path -LiteralPath $runtimeDirectory) -and
            (Test-Path -LiteralPath $backupDirectory)) {
            try {
                Move-Item -LiteralPath $backupDirectory -Destination $runtimeDirectory
            }
            catch {
                $preserveStaging = $true
                throw
            }
        }
        throw
    }

    try {
        $verified = Assert-NativeRuntime `
            -RuntimeDirectory $runtimeDirectory `
            -RepoRoot $repoRoot `
            -CheckSources
    }
    catch {
        $verificationError = $_
        $failedRuntimeDirectory = Join-Path $stagingDirectory 'failed-runtime'
        try {
            if (Test-Path -LiteralPath $runtimeDirectory) {
                Move-Item -LiteralPath $runtimeDirectory -Destination $failedRuntimeDirectory
            }
            if (Test-Path -LiteralPath $backupDirectory) {
                Move-Item -LiteralPath $backupDirectory -Destination $runtimeDirectory
            }
        }
        catch {
            $preserveStaging = $true
            throw (
                'Native runtime post-publish verification failed and rollback also failed. ' +
                "Previous runtime is preserved under $backupDirectory. " +
                "Verification: $($verificationError.Exception.Message) Rollback: $($_.Exception.Message)"
            )
        }
        throw $verificationError
    }
    $publishCommitted = $true

    $output = @($verified.outputs | Where-Object { $_.name -eq 'SharpShot.Native.exe' })[0]
    Write-Output (
        'Native runtime vendored: {0} bytes, SHA-256 {1}; isolated self-test PASS.' -f
        $output.bytes, $output.sha256
    )
}
finally {
    if ($preserveStaging -or
        (-not $publishCommitted -and
        (Test-Path -LiteralPath $backupDirectory) -and
        -not (Test-Path -LiteralPath $runtimeDirectory))) {
        Write-Warning (
            'Preserving the previous native runtime after a failed rollback: ' +
            $backupDirectory
        )
    }
    else {
        Remove-SafeDirectory $stagingDirectory $stagingRoot 'native-vendor-'
    }
}
}
finally {
    if ($vendorMutexHeld) {
        $vendorMutex.ReleaseMutex()
    }
    $vendorMutex.Dispose()
}
