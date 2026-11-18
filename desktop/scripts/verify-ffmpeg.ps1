[CmdletBinding()]
param(
    [string]$RuntimeDirectory,
    [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'ffmpeg-compliance-policy.ps1')
if (-not $RuntimeDirectory) {
    $RuntimeDirectory = Join-Path $desktopRoot 'resources\ffmpeg\win32-x64'
}
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeDirectory)
$manifestPath = Join-Path $runtimeRoot 'runtime-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "FFmpeg runtime manifest not found: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$complianceProperty = $manifest.PSObject.Properties['complianceStatus']
$complianceStatus = if ($null -eq $complianceProperty) { $null } else { $complianceProperty.Value }
Assert-FfmpegComplianceStatus -Status $complianceStatus

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

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $nativeOutput = @(& $Executable @Arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $joined = $nativeOutput -join "`n"
    if ($exitCode -ne 0) {
        throw "$(Split-Path -Leaf $Executable) exited with code $exitCode.`n$joined"
    }
    return $joined
}

function Assert-Capability([string]$Output, [string]$Name, [string]$Kind) {
    $escaped = [Regex]::Escape($Name)
    if ($Output -notmatch "(?m)^\s*[.A-Z]+\s+$escaped\s") {
        throw "Pinned FFmpeg is missing required $Kind '$Name'."
    }
}

foreach ($entry in $manifest.files) {
    $path = Join-Path $runtimeRoot ([string]$entry.name)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "FFmpeg runtime file is missing: $($entry.name). Run npm run media:vendor."
    }
    $item = Get-Item -LiteralPath $path
    if ($item.Length -ne [Int64]$entry.bytes) {
        throw "Unexpected byte count for $($entry.name): $($item.Length), expected $($entry.bytes)."
    }
    $hash = Get-Sha256 $path
    if ($hash -ne [string]$entry.sha256) {
        throw "Unexpected SHA-256 for $($entry.name): $hash."
    }
}

$unexpectedDirectories = @(
    Get-ChildItem -LiteralPath $runtimeRoot -Force |
        Where-Object { $_.PSIsContainer }
)
if ($unexpectedDirectories.Count -gt 0) {
    throw (
        'FFmpeg runtime directory must be flat; unexpected directories: ' +
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
        'FFmpeg runtime directory must not contain reparse points: ' +
        (($reparsePoints | ForEach-Object { $_.Name }) -join ', ')
    )
}
$expectedRuntimeNames = @(
    @('runtime-manifest.json') + @($manifest.files | ForEach-Object { [string]$_.name }) |
        Sort-Object
)
$actualRuntimeNames = @(
    Get-ChildItem -LiteralPath $runtimeRoot -File -Force |
        Sort-Object Name |
        ForEach-Object { $_.Name }
)
if ($actualRuntimeNames.Count -ne $expectedRuntimeNames.Count -or
    (Compare-Object -CaseSensitive $expectedRuntimeNames $actualRuntimeNames)) {
    throw 'FFmpeg runtime directory contains an unexpected or missing file.'
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The bundled FFmpeg runtime can only be executed and verified on Windows.'
}

$ffmpeg = Join-Path $runtimeRoot 'ffmpeg.exe'
$ffprobe = Join-Path $runtimeRoot 'ffprobe.exe'
$versionOutput = Invoke-Checked $ffmpeg @('-version')
if ($versionOutput -notmatch [Regex]::Escape([string]$manifest.version)) {
    throw "FFmpeg did not report pinned version $($manifest.version)."
}
$buildRecordPath = Join-Path $runtimeRoot 'BUILD_CONFIGURATION.txt'
$buildRecordLines = @(Get-Content -LiteralPath $buildRecordPath)
$recordedConfigurationLine = @(
    $buildRecordLines | Where-Object { $_.StartsWith('Configuration: ', [StringComparison]::Ordinal) }
)
if ($recordedConfigurationLine.Count -ne 1) {
    throw 'BUILD_CONFIGURATION.txt must contain exactly one Configuration line.'
}
$reportedConfigurationLine = @(
    ($versionOutput -split "`r?`n") |
        Where-Object { $_.StartsWith('configuration: ', [StringComparison]::Ordinal) }
)
if ($reportedConfigurationLine.Count -ne 1) {
    throw 'FFmpeg did not report exactly one configuration line.'
}
$recordedConfiguration = $recordedConfigurationLine[0].Substring('Configuration: '.Length)
$reportedConfiguration = $reportedConfigurationLine[0].Substring('configuration: '.Length)
if ($reportedConfiguration -cne $recordedConfiguration) {
    throw 'FFmpeg configure flags differ from BUILD_CONFIGURATION.txt.'
}
foreach ($requiredFlag in @('--enable-version3', '--enable-shared', '--disable-static')) {
    if (-not $versionOutput.Contains($requiredFlag)) {
        throw "FFmpeg configuration is missing $requiredFlag."
    }
}
foreach ($forbiddenFlag in @('--enable-gpl', '--enable-nonfree')) {
    if ($versionOutput.Contains($forbiddenFlag)) {
        throw "FFmpeg configuration unexpectedly contains $forbiddenFlag."
    }
}
foreach ($disabledLibrary in @('--disable-libx264', '--disable-libx265')) {
    if (-not $versionOutput.Contains($disabledLibrary)) {
        throw "FFmpeg configuration does not prove $disabledLibrary."
    }
}
$licenseOutput = Invoke-Checked $ffmpeg @('-L')
if ($licenseOutput -notmatch 'GNU Lesser General Public License' -or
    $licenseOutput -notmatch 'version 3') {
    throw 'FFmpeg did not report the expected LGPLv3-or-later license text.'
}
$probeVersionOutput = Invoke-Checked $ffprobe @('-version')
if ($probeVersionOutput -notmatch [Regex]::Escape([string]$manifest.version)) {
    throw "ffprobe did not report pinned version $($manifest.version)."
}

$encoders = Invoke-Checked $ffmpeg @('-hide_banner', '-encoders')
foreach ($encoder in $manifest.requiredEncoders) {
    Assert-Capability $encoders ([string]$encoder) 'encoder'
}
$muxers = Invoke-Checked $ffmpeg @('-hide_banner', '-muxers')
foreach ($muxer in $manifest.requiredMuxers) {
    Assert-Capability $muxers ([string]$muxer) 'muxer'
}
$filters = Invoke-Checked $ffmpeg @('-hide_banner', '-filters')
foreach ($filter in $manifest.requiredFilters) {
    Assert-Capability $filters ([string]$filter) 'filter'
}

if ($SmokeTest) {
    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) (
        'SharpShot-FFmpeg-Smoke-' + [Guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    try {
        $mp4Path = Join-Path $temporaryDirectory 'composited-h264-aac.mp4'
        $palettePath = Join-Path $temporaryDirectory 'palette.png'
        $gifPath = Join-Path $temporaryDirectory 'palette.gif'
        $mp4Graph = (
            '[0:v]scale=240:120:flags=lanczos,format=rgba[foreground];' +
            '[2:v][foreground]overlay=x=40:y=30:shortest=1,format=nv12[video]'
        )
        Invoke-Checked $ffmpeg @(
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=240x120:rate=30',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
            '-f', 'lavfi', '-i', 'gradients=s=320x180:r=30:d=1:n=2:c0=0x20252B:c1=0x3D6AEA',
            '-filter_complex', $mp4Graph,
            '-map', '[video]', '-map', '1:a:0',
            '-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', '80',
            '-scenario', 'archive', '-pix_fmt', 'nv12', '-hw_encoding', '0',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
            '-movflags', '+faststart', '-y', $mp4Path
        ) | Out-Null
        Invoke-Checked $ffmpeg @(
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=320x180:rate=30',
            '-vf', 'fps=12,palettegen=stats_mode=full:reserve_transparent=0',
            '-frames:v', '1', '-update', '1', '-y', $palettePath
        ) | Out-Null
        Invoke-Checked $ffmpeg @(
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=320x180:rate=30',
            '-i', $palettePath,
            '-filter_complex', '[0:v]fps=12[source];[source][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle[video]',
            '-map', '[video]', '-an', '-c:v', 'gif', '-loop', '0', '-y', $gifPath
        ) | Out-Null

        $mp4ProbeText = Invoke-Checked $ffprobe @(
            '-v', 'error', '-show_streams', '-show_format', '-of', 'json', $mp4Path
        )
        $mp4Probe = $mp4ProbeText | ConvertFrom-Json
        $mp4Video = @($mp4Probe.streams | Where-Object { $_.codec_type -eq 'video' })
        $mp4Audio = @($mp4Probe.streams | Where-Object { $_.codec_type -eq 'audio' })
        if ($mp4Video.Count -ne 1 -or $mp4Video[0].codec_name -ne 'h264' -or
            $mp4Video[0].width -ne 320 -or $mp4Video[0].height -ne 180) {
            throw 'Smoke MP4 does not contain the expected 320x180 H.264 video stream.'
        }
        if ($mp4Audio.Count -ne 1 -or $mp4Audio[0].codec_name -ne 'aac' -or
            $mp4Audio[0].sample_rate -ne '48000' -or $mp4Audio[0].channels -ne 2) {
            throw 'Smoke MP4 does not contain the expected stereo 48 kHz AAC stream.'
        }
        $mp4Duration = [Double]::Parse(
            [string]$mp4Probe.format.duration,
            [Globalization.CultureInfo]::InvariantCulture
        )
        if ($mp4Duration -lt 0.9 -or $mp4Duration -gt 1.1) {
            throw "Smoke MP4 duration is unexpected: $mp4Duration seconds."
        }

        $gifProbeText = Invoke-Checked $ffprobe @(
            '-v', 'error', '-show_streams', '-show_format', '-of', 'json', $gifPath
        )
        $gifProbe = $gifProbeText | ConvertFrom-Json
        $gifVideo = @($gifProbe.streams | Where-Object { $_.codec_type -eq 'video' })
        if ($gifVideo.Count -ne 1 -or $gifVideo[0].codec_name -ne 'gif' -or
            $gifVideo[0].width -ne 320 -or $gifVideo[0].height -ne 180) {
            throw 'Smoke GIF does not contain the expected 320x180 GIF stream.'
        }
        $gifDuration = [Double]::Parse(
            [string]$gifProbe.format.duration,
            [Globalization.CultureInfo]::InvariantCulture
        )
        if ($gifDuration -lt 0.9 -or $gifDuration -gt 1.1) {
            throw "Smoke GIF duration is unexpected: $gifDuration seconds."
        }
        Write-Output 'FFmpeg smoke export: H.264/AAC MP4 and two-pass GIF passed.'
    }
    finally {
        if (Test-Path -LiteralPath $temporaryDirectory) {
            $resolvedTemporary = [IO.Path]::GetFullPath($temporaryDirectory)
            $systemTemporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
            $leaf = Split-Path -Leaf $resolvedTemporary
            if ($resolvedTemporary.StartsWith($systemTemporary, [StringComparison]::OrdinalIgnoreCase) -and
                $leaf.StartsWith('SharpShot-FFmpeg-Smoke-', [StringComparison]::Ordinal)) {
                Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
            }
            else {
                throw "Refusing to remove unexpected smoke-test path: $resolvedTemporary"
            }
        }
    }
}

$runtimeBytes = ($manifest.files | Where-Object {
    ([IO.Path]::GetExtension([string]$_.name)) -in @('.exe', '.dll')
} | Measure-Object -Property bytes -Sum).Sum
$distributionStatus = if ($complianceStatus -ceq 'verified') {
    'public-release compliance verified'
}
else {
    'local verification only; public Full Studio distribution is blocked pending a complete dependency inventory'
}
Write-Output (
    "FFmpeg runtime verified: {0}, {1:N1} MiB, FFmpeg LGPL-3.0-or-later; {2}." -f
    $manifest.version, ($runtimeBytes / 1MB), $distributionStatus
)
