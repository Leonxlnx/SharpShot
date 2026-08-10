$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $root 'tools\GenerateStudioIcon.cs'
$output = Join-Path $root 'resources\icons\sharpshot-studio.ico'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('SharpShotStudioIcon-' + [Guid]::NewGuid().ToString('N') + '.exe')
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework x64 C# compiler was not found.' }

try {
    & $compiler /nologo /target:exe /optimize+ /warn:4 `
        /reference:System.dll /reference:System.Drawing.dll `
        /out:"$temporary" "$source"
    if ($LASTEXITCODE -ne 0) { throw 'Studio icon generator compilation failed.' }
    & $temporary $output
    if ($LASTEXITCODE -ne 0) { throw 'Studio icon generation failed.' }
    Write-Output $output
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
