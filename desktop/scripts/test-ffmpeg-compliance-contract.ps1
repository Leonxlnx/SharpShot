[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $desktopRoot 'resources\ffmpeg\win32-x64'
$manifestPath = Join-Path $runtimeRoot 'runtime-manifest.json'
$blockedNoticePath = Join-Path $runtimeRoot 'COMPLIANCE-BLOCKED.md'

. (Join-Path $PSScriptRoot 'ffmpeg-compliance-policy.ps1')

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

function Assert-Throws([scriptblock]$Action, [string]$Needle) {
    try {
        & $Action
    }
    catch {
        if (-not $_.Exception.Message.Contains($Needle)) {
            throw "Expected failure containing '$Needle', got: $($_.Exception.Message)"
        }
        return
    }
    throw "Expected failure containing '$Needle'."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.complianceStatus -cne 'blocked-incomplete-third-party-inventory') {
    throw 'The current broad BtbN runtime must remain explicitly blocked.'
}

Assert-FfmpegComplianceStatus -Status 'blocked-incomplete-third-party-inventory'
Assert-FfmpegComplianceStatus -Status 'verified'
Assert-Throws {
    Assert-FfmpegComplianceStatus -Status 'blocked-incomplete-third-party-inventory' -PublicRelease
} "must be exactly 'verified'"
Assert-FfmpegComplianceStatus -Status 'verified' -PublicRelease
Assert-Throws { Assert-FfmpegComplianceStatus -Status $null } 'unknown complianceStatus'
Assert-Throws { Assert-FfmpegComplianceStatus -Status 'Verified' } 'unknown complianceStatus'
Assert-Throws { Assert-FfmpegComplianceStatus -Status 'pending' } 'unknown complianceStatus'

$noticeEntries = @($manifest.files | Where-Object { $_.name -ceq 'COMPLIANCE-BLOCKED.md' })
if ($noticeEntries.Count -ne 1) {
    throw 'runtime-manifest.json must contain exactly one COMPLIANCE-BLOCKED.md entry.'
}
$noticeEntry = $noticeEntries[0]
$noticeItem = Get-Item -LiteralPath $blockedNoticePath
$noticeHash = Get-LowerSha256 $blockedNoticePath
if ($noticeItem.Length -ne [Int64]$noticeEntry.bytes -or
    $noticeHash -cne [string]$noticeEntry.sha256) {
    throw 'COMPLIANCE-BLOCKED.md bytes differ from runtime-manifest.json.'
}

$notice = Get-Content -LiteralPath $blockedNoticePath -Raw
foreach ($required in @(
    'https://ffmpeg.org/legal.html',
    '9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b',
    'a99e8230eae00d1cee38f23076a7a1f55cd984e2',
    'images/base-win64/Dockerfile',
    'scripts.d/50-rav1e.sh',
    'cargo update cc',
    'No other status authorizes publication.'
)) {
    if (-not $notice.Contains($required)) {
        throw "COMPLIANCE-BLOCKED.md is missing evidence or policy text: $required"
    }
}

$verifier = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'verify-ffmpeg.ps1') -Raw
foreach ($required in @(
    'ffmpeg-compliance-policy.ps1',
    'Assert-FfmpegComplianceStatus -Status $complianceStatus'
)) {
    if (-not $verifier.Contains($required)) {
        throw "verify-ffmpeg.ps1 is missing the local compliance contract: $required"
    }
}

Write-Output 'FFmpeg compliance contract verified: local use allowed; public Full Studio release blocked.'
