[CmdletBinding()]
param(
    [string]$RuntimeDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'native-build-common.ps1')

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
if (-not $RuntimeDirectory) {
    $RuntimeDirectory = Join-Path $desktopRoot 'resources\native\win32-x64'
}
$manifest = Assert-NativeRuntime `
    -RuntimeDirectory $RuntimeDirectory `
    -RepoRoot $repoRoot `
    -CheckSources
$output = @($manifest.outputs | Where-Object { $_.name -eq 'SharpShot.Native.exe' })[0]
Write-Output (
    'Native runtime verified current: {0} bytes, SHA-256 {1}; recorded self-test PASS.' -f
    $output.bytes, $output.sha256
)
