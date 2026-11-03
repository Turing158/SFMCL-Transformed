#requires -Version 5.1
<#
.SYNOPSIS
Build Windows x64/x86 installer, single, or both packages.
.EXAMPLE
.\build.ps1 installer
.EXAMPLE
.\build.ps1 single -NoExeCompression
.EXAMPLE
.\build.ps1 -Architecture x86
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('installer', 'single', 'all')]
    [string]$Mode = 'all',
    [ValidateSet('x64', 'x86', 'all')]
    [string]$Architecture = 'all',
    [switch]$NoExeCompression,
    [switch]$InstallDependencies,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $PSScriptRoot 'SFMCL-T'
. (Join-Path $projectRoot 'scripts\windows-common.ps1')
. (Join-Path $projectRoot 'scripts\compression.ps1')
$scratch = $null
$previousOutputEncoding = [Console]::OutputEncoding
$previousCxxFlags = @{}
Push-Location -LiteralPath $PSScriptRoot
try {
    # Cargo and Node emit UTF-8, including paths containing Chinese characters.
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $modes = if ($Mode -eq 'all') { @('single', 'installer') } else { @($Mode) }
    $architectures = if ($Architecture -eq 'all') { @('x64', 'x86') } else { @($Architecture) }
    $targetByArchitecture = @{ x64 = 'x86_64-pc-windows-msvc'; x86 = 'i686-pc-windows-msvc' }
    $targets = @($architectures | ForEach-Object { $targetByArchitecture[$_] })
    if ($NoExeCompression -and 'single' -notin $modes) {
        throw '-NoExeCompression applies only to single/all.'
    }
    Assert-DevelopmentTools -Targets $targets
    if ($Check) {
        Write-Host "Build prerequisites OK. Modes: $($modes -join ', '); architectures: $($architectures -join ', ')"
        exit 0
    }
    Set-Location -LiteralPath $projectRoot
    Sync-NodeDependencies -ProjectRoot $projectRoot -Force:$InstallDependencies
    Repair-StaleCargoCache -WorkspaceRoot $projectRoot
    $config = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
    $metadataJson = & cargo.exe metadata --format-version 1 --no-deps --locked
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read Cargo workspace metadata.' }
    $metadata = $metadataJson | ConvertFrom-Json
    $output = Join-Path $PSScriptRoot 'release'
    $toolCache = Join-Path $PSScriptRoot '.runtime\packaging\tools'
    $scratch = Join-Path $PSScriptRoot ('.runtime\packaging\runs\' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($output)
    [void][IO.Directory]::CreateDirectory($scratch)
    $cli = 'node_modules/@tauri-apps/cli/tauri.js'
    $artifacts = @()
    foreach ($architectureName in $architectures) {
        $target = $targetByArchitecture[$architectureName]
        $binaryDirectory = Join-Path $metadata.target_directory "$target\release"
        $binary = Join-Path $binaryDirectory "$($config.mainBinaryName).exe"
        $name = "$($config.productName)_v$($config.version)_$architectureName"
        # Tauri's static VC runtime setting does not reach cc-based C++ dependencies.
        # UnRAR must also use /MT so a single-file release does not need MSVCP140.dll.
        $cxxVariable = 'CXXFLAGS_' + $target.Replace('-', '_')
        $previousCxxFlags[$cxxVariable] = [Environment]::GetEnvironmentVariable($cxxVariable, 'Process')
        [Environment]::SetEnvironmentVariable($cxxVariable, ($previousCxxFlags[$cxxVariable] + ' /MT').Trim(), 'Process')
        # Compile once per architecture, then reuse the executable for both package types.
        Write-Host "Building Windows $architectureName ($target)..."
        Invoke-Checked -File 'node.exe' -Arguments @($cli, 'build', '--no-bundle', '--ci', '--target', $target, '--', '--locked')
        if (-not (Test-Path -LiteralPath $binary)) { throw "Missing build output: $binary" }
        Assert-StandaloneExecutable -Path $binary -Architecture $architectureName

        if ('single' -in $modes) {
            $destination = Join-Path $output "${name}.exe"
            $single = Join-Path $scratch "${name}.exe"
            if ($NoExeCompression) {
                Copy-Item -LiteralPath $binary -Destination $single
            } else {
                Compress-SingleExecutable -Source $binary -Destination $single -CacheRoot $toolCache
            }
            if ((Get-ExecutableArchitecture -Path $single) -ne $architectureName) {
                throw "Single executable has the wrong architecture: $single"
            }
            Move-Item -LiteralPath $single -Destination $destination -Force
            $artifacts += $destination
            Write-Host "Single executable: $destination"
        }

        if ('installer' -in $modes) {
            Invoke-Checked -File 'node.exe' -Arguments @($cli, 'bundle', '--bundles', 'nsis', '--ci', '--target', $target)
            # Tauri's internal bundle filename uses the raw version; release filenames add v.
            $setup = Join-Path $binaryDirectory "bundle\nsis\$($config.productName)_$($config.version)_$architectureName-setup.exe"
            if (-not (Test-Path -LiteralPath $setup)) { throw "NSIS did not produce the expected installer: $setup" }
            $destination = Join-Path $output "${name}_installer.exe"
            Copy-Item -LiteralPath $setup -Destination $destination -Force
            $artifacts += $destination
        }
    }

    foreach ($artifact in $artifacts) {
        $file = Get-Item -LiteralPath $artifact
        Write-Host ("{0} ({1:N1} MiB)" -f $file.FullName, ($file.Length / 1MB))
        Write-Host ("  SHA256: " + (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash)
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    [Console]::OutputEncoding = $previousOutputEncoding
    foreach ($cxxVariable in $previousCxxFlags.Keys) {
        [Environment]::SetEnvironmentVariable($cxxVariable, $previousCxxFlags[$cxxVariable], 'Process')
    }
    if ($scratch) {
        Remove-PackagingScratch -Path $scratch -Root (Join-Path $PSScriptRoot '.runtime\packaging\runs')
    }
    Pop-Location
}
