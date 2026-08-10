function Get-PathAttributesOrNull([string]$Path) {
    try {
        return [IO.File]::GetAttributes([IO.Path]::GetFullPath($Path))
    }
    catch [IO.FileNotFoundException] {
        return $null
    }
    catch [IO.DirectoryNotFoundException] {
        return $null
    }
}

function Assert-NoReparseTree([string]$Path) {
    $rootAttributes = Get-PathAttributesOrNull $Path
    if ($null -eq $rootAttributes) { return }
    if (($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "Expected a directory reset target: $Path"
    }
    if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to traverse a reparse point: $Path"
    }
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
    $rootAttributes = Get-PathAttributesOrNull $rootFullPath
    if ($null -eq $rootAttributes) {
        throw "Trusted root does not exist: $rootFullPath"
    }
    if (($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "Trusted root is not a directory: $rootFullPath"
    }
    if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Trusted root is a reparse point: $rootFullPath"
    }
    $currentPath = $rootFullPath
    $relativePath = $pathFullPath.Substring($rootFullPath.Length).TrimStart('\')
    foreach ($segment in @($relativePath.Split('\') | Where-Object { $_.Length -gt 0 })) {
        $currentPath = Join-Path $currentPath $segment
        $attributes = Get-PathAttributesOrNull $currentPath
        if ($null -eq $attributes) { continue }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Path component is a reparse point: $currentPath"
        }
    }
}

function Assert-SafeDirectoryTarget(
    [string]$TrustedRoot,
    [string]$Path,
    [string]$RequiredRelativePath
) {
    $rootFullPath = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd('\')
    $pathFullPath = [IO.Path]::GetFullPath($Path)
    $expectedPath = [IO.Path]::GetFullPath((Join-Path $rootFullPath $RequiredRelativePath))
    if (-not $pathFullPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        $pathFullPath.Equals($rootFullPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unexpected directory target: $pathFullPath"
    }
    Assert-NoReparsePathComponents -TrustedRoot $rootFullPath -Path $pathFullPath
    Assert-NoReparseTree -Path $pathFullPath
}

function Remove-SafeDirectoryExact(
    [string]$TrustedRoot,
    [string]$Path,
    [string]$RequiredRelativePath
) {
    Assert-SafeDirectoryTarget `
        -TrustedRoot $TrustedRoot `
        -Path $Path `
        -RequiredRelativePath $RequiredRelativePath
    if ($null -ne (Get-PathAttributesOrNull $Path)) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Reset-SafeDirectoryExact(
    [string]$TrustedRoot,
    [string]$Path,
    [string]$RequiredRelativePath
) {
    Remove-SafeDirectoryExact `
        -TrustedRoot $TrustedRoot `
        -Path $Path `
        -RequiredRelativePath $RequiredRelativePath
    Assert-NoReparsePathComponents -TrustedRoot $TrustedRoot -Path $Path
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Assert-NoReparsePathComponents -TrustedRoot $TrustedRoot -Path $Path
}
