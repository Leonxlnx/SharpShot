[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $repoRoot 'tools\safe-directory.ps1')

function Assert-ResetRefused([scriptblock]$Operation, [string]$Label, [string]$Sentinel) {
    $refused = $false
    try {
        & $Operation
    }
    catch {
        $refused = $true
    }
    if (-not $refused) { throw "Unsafe reset was not refused: $Label" }
    if (-not (Test-Path -LiteralPath $Sentinel -PathType Leaf)) {
        throw "Outside sentinel was changed by refused reset: $Label"
    }
}

function Remove-TestJunction([string]$Path) {
    $attributes = Get-PathAttributesOrNull $Path
    if ($null -eq $attributes) { return }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "Test cleanup expected a junction: $Path"
    }
    [IO.Directory]::Delete([IO.Path]::GetFullPath($Path))
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$caseLeaf = 'SharpShot-SafeDirectory-Test-' + [Guid]::NewGuid().ToString('N')
$caseRoot = Join-Path $tempRoot $caseLeaf
$junctions = New-Object Collections.Generic.List[string]
try {
    Assert-SafeDirectoryTarget -TrustedRoot $tempRoot -Path $caseRoot -RequiredRelativePath $caseLeaf
    New-Item -ItemType Directory -Path $caseRoot | Out-Null
    $trusted = Join-Path $caseRoot 'trusted'
    $outside = Join-Path $caseRoot 'outside'
    New-Item -ItemType Directory -Path $trusted, $outside | Out-Null
    $sentinel = Join-Path $outside 'sentinel.txt'
    Set-Content -LiteralPath $sentinel -Value 'must survive' -Encoding ascii

    $valid = Join-Path $trusted 'build'
    New-Item -ItemType Directory -Path $valid | Out-Null
    Set-Content -LiteralPath (Join-Path $valid 'old.txt') -Value 'old' -Encoding ascii
    Reset-SafeDirectoryExact -TrustedRoot $trusted -Path $valid -RequiredRelativePath 'build'
    if (-not (Test-Path -LiteralPath $valid -PathType Container) -or
        @(Get-ChildItem -LiteralPath $valid -Force).Count -ne 0) {
        throw 'Valid safe reset did not recreate an empty directory.'
    }

    $siblingEscape = Join-Path $caseRoot 'trusted-sibling\build'
    Assert-ResetRefused {
        Reset-SafeDirectoryExact -TrustedRoot $trusted -Path $siblingEscape -RequiredRelativePath 'build'
    } 'sibling-prefix escape' $sentinel
    Assert-ResetRefused {
        Reset-SafeDirectoryExact -TrustedRoot $trusted -Path $valid -RequiredRelativePath 'release'
    } 'wrong required path' $sentinel

    $trustedReal = Join-Path $caseRoot 'trusted-real'
    $trustedLink = Join-Path $caseRoot 'trusted-link'
    New-Item -ItemType Directory -Path $trustedReal | Out-Null
    New-Item -ItemType Junction -Path $trustedLink -Target $trustedReal | Out-Null
    $junctions.Add($trustedLink)
    Assert-ResetRefused {
        Reset-SafeDirectoryExact `
            -TrustedRoot $trustedLink `
            -Path (Join-Path $trustedLink 'build') `
            -RequiredRelativePath 'build'
    } 'trusted-root junction' $sentinel
    Remove-TestJunction $trustedLink
    $junctions.Remove($trustedLink) | Out-Null

    $parentTarget = Join-Path $outside 'parent-target'
    $parentLink = Join-Path $trusted 'artifacts'
    New-Item -ItemType Directory -Path $parentTarget | Out-Null
    New-Item -ItemType Junction -Path $parentLink -Target $parentTarget | Out-Null
    $junctions.Add($parentLink)
    Assert-ResetRefused {
        Reset-SafeDirectoryExact `
            -TrustedRoot $trusted `
            -Path (Join-Path $parentLink 'native') `
            -RequiredRelativePath 'artifacts\native'
    } 'parent junction' $sentinel
    Remove-TestJunction $parentLink
    $junctions.Remove($parentLink) | Out-Null

    Remove-SafeDirectoryExact -TrustedRoot $trusted -Path $valid -RequiredRelativePath 'build'
    $targetOutside = Join-Path $outside 'target-junction'
    New-Item -ItemType Directory -Path $targetOutside | Out-Null
    New-Item -ItemType Junction -Path $valid -Target $targetOutside | Out-Null
    $junctions.Add($valid)
    Assert-ResetRefused {
        Reset-SafeDirectoryExact -TrustedRoot $trusted -Path $valid -RequiredRelativePath 'build'
    } 'target junction' $sentinel
    Remove-TestJunction $valid
    $junctions.Remove($valid) | Out-Null

    New-Item -ItemType Directory -Path $valid | Out-Null
    $nestedTarget = Join-Path $outside 'nested-target'
    $nestedLink = Join-Path $valid 'nested-link'
    New-Item -ItemType Directory -Path $nestedTarget | Out-Null
    New-Item -ItemType Junction -Path $nestedLink -Target $nestedTarget | Out-Null
    $junctions.Add($nestedLink)
    Assert-ResetRefused {
        Reset-SafeDirectoryExact -TrustedRoot $trusted -Path $valid -RequiredRelativePath 'build'
    } 'nested descendant junction' $sentinel
    Remove-TestJunction $nestedLink
    $junctions.Remove($nestedLink) | Out-Null
    Remove-SafeDirectoryExact -TrustedRoot $trusted -Path $valid -RequiredRelativePath 'build'

    $danglingTarget = Join-Path $outside 'dangling-target'
    New-Item -ItemType Directory -Path $danglingTarget | Out-Null
    New-Item -ItemType Junction -Path $valid -Target $danglingTarget | Out-Null
    $junctions.Add($valid)
    Remove-SafeDirectoryExact `
        -TrustedRoot $caseRoot `
        -Path $danglingTarget `
        -RequiredRelativePath 'outside\dangling-target'
    Assert-ResetRefused {
        Reset-SafeDirectoryExact -TrustedRoot $trusted -Path $valid -RequiredRelativePath 'build'
    } 'dangling target junction' $sentinel
    Remove-TestJunction $valid
    $junctions.Remove($valid) | Out-Null

    Write-Output 'Safe-directory reset and junction adversarial checks passed.'
}
finally {
    foreach ($junction in @($junctions)) {
        Remove-TestJunction $junction
    }
    if ($null -ne (Get-PathAttributesOrNull $caseRoot)) {
        Remove-SafeDirectoryExact `
            -TrustedRoot $tempRoot `
            -Path $caseRoot `
            -RequiredRelativePath $caseLeaf
    }
}
