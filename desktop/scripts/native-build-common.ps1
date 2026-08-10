Set-StrictMode -Version Latest

function Get-NativeSha256([string]$Path) {
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

function Get-NativeStringSha256([string]$Value) {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-NativeCompileContract() {
    return @(
        'SharpShot.Native build contract v1'
        'embedded-version=1.5.0.0'
        'icon-source=tools/GenerateIcon.cs'
        'icon-arguments=/nologo /target:exe /optimize+ /warn:4 /reference:System.dll /reference:System.Drawing.dll /out:<staging>/GenerateIcon.exe tools/GenerateIcon.cs'
        'icon-run=<staging>/GenerateIcon.exe <staging>/SharpShot.ico'
        'application-sources=src/SharpShot/*.cs sorted by Name'
        'application-arguments=/nologo /target:winexe /optimize+ /warn:4 /platform:x64 /win32manifest:src/SharpShot/app.manifest /win32icon:<staging>/SharpShot.ico /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /out:<staging>/SharpShot.exe <application-sources>'
        'runtime-config=src/SharpShot/SharpShot.exe.config'
        'self-test=<staging>/SharpShot.exe --self-test <fresh-output-directory>'
        'publish-executable=desktop/resources/native/win32-x64/SharpShot.Native.exe'
        'publish-config=desktop/resources/native/win32-x64/SharpShot.Native.exe.config'
    ) -join "`n"
}

function Get-NativeExpectedVersion() {
    return '1.5.0.0'
}

function Get-NativeCompileSources([string]$RepoRoot) {
    $sourceRoot = Join-Path $RepoRoot 'src\SharpShot'
    return @(
        Get-ChildItem -LiteralPath $sourceRoot -Filter '*.cs' -File |
            Sort-Object Name |
            ForEach-Object { $_.FullName }
    )
}

function Get-NativeSourceEntries([string]$RepoRoot) {
    $repoFullPath = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
    $repoPrefix = $repoFullPath + '\'
    $paths = @(
        Get-NativeCompileSources $repoFullPath
        (Join-Path $repoFullPath 'src\SharpShot\app.manifest')
        (Join-Path $repoFullPath 'src\SharpShot\SharpShot.exe.config')
        (Join-Path $repoFullPath 'tools\GenerateIcon.cs')
    )
    $entries = foreach ($path in $paths) {
        $fullPath = [IO.Path]::GetFullPath($path)
        if (-not $fullPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Native build input is outside the repository: $fullPath"
        }
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Native build input is missing: $fullPath"
        }
        $item = Get-Item -LiteralPath $fullPath
        [pscustomobject][ordered]@{
            path = $fullPath.Substring($repoPrefix.Length).Replace('\', '/')
            bytes = [Int64]$item.Length
            sha256 = Get-NativeSha256 $fullPath
            lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('O')
        }
    }
    return @($entries | Sort-Object path)
}

function Get-NativeSourceObservationFingerprint($Entries) {
    $records = @(
        $Entries | ForEach-Object {
            '{0}|{1}|{2}|{3}' -f (
                [string]$_.path
            ), ([Int64]$_.bytes), ([string]$_.sha256), ([string]$_.lastWriteTimeUtc)
        }
    )
    return Get-NativeStringSha256 ($records -join "`n")
}

function Get-NativeSourceFingerprint($Entries) {
    $records = @(
        $Entries | ForEach-Object {
            '{0}|{1}|{2}' -f ([string]$_.path), ([Int64]$_.bytes), ([string]$_.sha256)
        }
    )
    return Get-NativeStringSha256 ($records -join "`n")
}

function Assert-NativeX64Pe([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            throw "Native helper has no DOS MZ header: $Path"
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
            throw "Native helper has an invalid PE offset: $Path"
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "Native helper has no PE signature: $Path"
        }
        if ($reader.ReadUInt16() -ne 0x8664) {
            throw "Native helper is not an x64 PE image: $Path"
        }
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Assert-NativeVersion([string]$Path) {
    $expectedVersion = Get-NativeExpectedVersion
    $versionInfo = (Get-Item -LiteralPath $Path).VersionInfo
    $assemblyVersion = [Reflection.AssemblyName]::GetAssemblyName($Path).Version.ToString()
    if ([string]$versionInfo.FileVersion -cne $expectedVersion -or
        [string]$versionInfo.ProductVersion -cne $expectedVersion -or
        $assemblyVersion -cne $expectedVersion) {
        throw (
            "Native helper version mismatch. File=$($versionInfo.FileVersion), " +
            "Product=$($versionInfo.ProductVersion), Assembly=$assemblyVersion; expected $expectedVersion."
        )
    }
}

function Assert-NativeRuntime(
    [string]$RuntimeDirectory,
    [string]$RepoRoot,
    [switch]$CheckSources
) {
    $runtimeRoot = [IO.Path]::GetFullPath($RuntimeDirectory)
    $manifestPath = Join-Path $runtimeRoot 'native-runtime-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Native runtime manifest not found: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([Int32]$manifest.schemaVersion -ne 1 -or
        [string]$manifest.runtime -ne 'SharpShot.Native' -or
        [string]$manifest.platform -ne 'win32-x64' -or
        [string]$manifest.version -cne (Get-NativeExpectedVersion)) {
        throw 'Native runtime manifest identity is invalid.'
    }

    $compileContract = Get-NativeCompileContract
    $compileContractHash = Get-NativeStringSha256 $compileContract
    if ([string]$manifest.compile.contract -cne $compileContract -or
        [string]$manifest.compile.contractSha256 -cne $compileContractHash) {
        throw 'Native runtime compile contract differs from the current packaging contract.'
    }

    if ($CheckSources) {
        $currentSources = @(Get-NativeSourceEntries $RepoRoot)
        $recordedSources = @($manifest.sources)
        if ($currentSources.Count -ne $recordedSources.Count) {
            throw "Native source set changed: $($currentSources.Count) files, manifest has $($recordedSources.Count)."
        }
        for ($index = 0; $index -lt $currentSources.Count; $index++) {
            $current = $currentSources[$index]
            $recorded = $recordedSources[$index]
            if ([string]$current.path -cne [string]$recorded.path -or
                [Int64]$current.bytes -ne [Int64]$recorded.bytes -or
                [string]$current.sha256 -cne [string]$recorded.sha256) {
                throw "Native build input is stale or changed: $($current.path). Run npm run native:vendor."
            }
        }
        $sourceFingerprint = Get-NativeSourceFingerprint $currentSources
        if ($sourceFingerprint -cne [string]$manifest.sourceFingerprintSha256) {
            throw 'Native source fingerprint differs from the runtime manifest.'
        }
    }

    if ([string]$manifest.selfTest.mode -ne '--self-test' -or
        [string]$manifest.selfTest.result -ne 'PASS') {
        throw 'Native runtime manifest does not record a passing isolated self-test.'
    }

    $requiredOutputNames = @('SharpShot.Native.exe', 'SharpShot.Native.exe.config')
    $manifestOutputNames = @(
        $manifest.outputs |
            ForEach-Object { [string]$_.name } |
            Sort-Object
    )
    $sortedRequiredOutputNames = @($requiredOutputNames | Sort-Object)
    if ($manifestOutputNames.Count -ne $sortedRequiredOutputNames.Count -or
        (Compare-Object -CaseSensitive $sortedRequiredOutputNames $manifestOutputNames)) {
        throw 'Native runtime manifest must describe exactly SharpShot.Native.exe and its config.'
    }

    $expectedNames = @('native-runtime-manifest.json')
    foreach ($output in @($manifest.outputs)) {
        $name = [string]$output.name
        if ([IO.Path]::GetFileName($name) -cne $name) {
            throw "Native runtime output name is unsafe: $name"
        }
        $path = Join-Path $runtimeRoot $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Native runtime output is missing: $name"
        }
        $item = Get-Item -LiteralPath $path
        if ($item.Length -ne [Int64]$output.bytes) {
            throw "Native runtime byte count differs for ${name}: $($item.Length), expected $($output.bytes)."
        }
        $hash = Get-NativeSha256 $path
        if ($hash -cne [string]$output.sha256) {
            throw "Native runtime SHA-256 differs for ${name}: $hash."
        }
        $expectedNames += $name
    }
    $unexpectedDirectories = @(
        Get-ChildItem -LiteralPath $runtimeRoot -Force |
            Where-Object { $_.PSIsContainer }
    )
    if ($unexpectedDirectories.Count -gt 0) {
        throw (
            'Native runtime directory must be flat; unexpected directories: ' +
            (($unexpectedDirectories | ForEach-Object { $_.Name }) -join ', ')
        )
    }
    $reparsePoints = @(
        Get-ChildItem -LiteralPath $runtimeRoot -Force |
            Where-Object {
                ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
            }
    )
    if ($reparsePoints.Count -gt 0) {
        throw (
            'Native runtime directory must not contain reparse points: ' +
            (($reparsePoints | ForEach-Object { $_.Name }) -join ', ')
        )
    }
    $actualNames = @(
        Get-ChildItem -LiteralPath $runtimeRoot -File -Force |
            Sort-Object Name |
            ForEach-Object { $_.Name }
    )
    $expectedNames = @($expectedNames | Sort-Object)
    if ($actualNames.Count -ne $expectedNames.Count -or
        (Compare-Object -CaseSensitive $expectedNames $actualNames)) {
        throw 'Native runtime directory contains an unexpected or missing file.'
    }

    $executable = Join-Path $runtimeRoot 'SharpShot.Native.exe'
    Assert-NativeX64Pe $executable
    Assert-NativeVersion $executable
    if ($CheckSources) {
        $currentSources = @(Get-NativeSourceEntries $RepoRoot)
        $newestSourceWrite = @(
            $currentSources | ForEach-Object { [DateTime]::Parse([string]$_.lastWriteTimeUtc).ToUniversalTime() }
        ) | Sort-Object -Descending | Select-Object -First 1
        $executableWrite = (Get-Item -LiteralPath $executable).LastWriteTimeUtc
        if ($newestSourceWrite -gt $executableWrite) {
            throw (
                "Native source is newer than SharpShot.Native.exe " +
                "($($newestSourceWrite.ToString('O')) > $($executableWrite.ToString('O'))). " +
                'Run npm run native:vendor.'
            )
        }
    }
    return $manifest
}
