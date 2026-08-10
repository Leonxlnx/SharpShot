function Assert-FfmpegComplianceStatus {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Status,

        [switch]$PublicRelease
    )

    $allowed = @(
        'verified',
        'blocked-incomplete-third-party-inventory'
    )
    if ($Status -isnot [string] -or $Status -cnotin $allowed) {
        throw (
            'FFmpeg runtime manifest has an unknown complianceStatus. ' +
            "Expected one of: $($allowed -join ', ')."
        )
    }
    if ($PublicRelease -and $Status -cne 'verified') {
        throw (
            'Public Full Studio release is blocked: FFmpeg complianceStatus ' +
            "must be exactly 'verified', found '$Status'."
        )
    }
}
