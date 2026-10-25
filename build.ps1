#requires -Version 5.1
<#
.SYNOPSIS
Build Windows x64 installer, portable (also spelled potable), single, or all packages.
.EXAMPLE
.\build.ps1 installer
.EXAMPLE
.\build.ps1 portable -WebView2Path D:\SDKs\WebView2
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('installer', 'portable', 'potable', 'single', 'all')]
    [string]$Mode = 'all',
    [string]$WebView2Path,
    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
    [string]$WebView2Version,
    [ValidateSet('7z', 'zip')]
    [string]$PortableFormat = '7z',
    [switch]$NoExeCompression,
    [switch]$InstallDependencies,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $PSScriptRoot 'SFMCL-T'
. (Join-Path $projectRoot 'scripts\windows-common.ps1')
. (Join-Path $projectRoot 'scripts\webview2.ps1')
. (Join-Path $projectRoot 'scripts\compression.ps1')
$scratch = $null
$previousOutputEncoding = [Console]::OutputEncoding
$previousCxxFlags = $env:CXXFLAGS_x86_64_pc_windows_msvc
Push-Location -LiteralPath $PSScriptRoot
try {
    # Cargo and Node emit UTF-8, including paths containing Chinese characters.
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if ($Mode -eq 'potable') { $Mode = 'portable' }
    $modes = if ($Mode -eq 'all') { @('single', 'portable', 'installer') } else { @($Mode) }
    if (($WebView2Path -or $WebView2Version) -and 'portable' -notin $modes) {
        throw '-WebView2Path and -WebView2Version apply only to portable/all.'
    }
    if ($PSBoundParameters.ContainsKey('PortableFormat') -and 'portable' -notin $modes) {
        throw '-PortableFormat applies only to portable/all.'
    }
    if ($NoExeCompression -and 'single' -notin $modes) {
        throw '-NoExeCompression applies only to single/all.'
    }
    Assert-DevelopmentTools
    if ($Check) {
        Write-Host "Build prerequisites OK. Modes: $($modes -join ', ')"
        exit 0
    }
    if ($WebView2Path) {
        $WebView2Path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WebView2Path)
    }
    Set-Location -LiteralPath $projectRoot
    Sync-NodeDependencies -ProjectRoot $projectRoot -Force:$InstallDependencies
    $config = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
    $metadataJson = & cargo.exe metadata --format-version 1 --no-deps --locked
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read Cargo workspace metadata.' }
    $metadata = $metadataJson | ConvertFrom-Json
    $target = 'x86_64-pc-windows-msvc'
    $binaryDirectory = Join-Path $metadata.target_directory "$target\release"
    $binary = Join-Path $binaryDirectory "$($config.mainBinaryName).exe"
    $output = Join-Path $PSScriptRoot 'release'
    $toolCache = Join-Path $PSScriptRoot '.runtime\packaging\tools'
    $scratch = Join-Path $PSScriptRoot ('.runtime\packaging\runs\' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($output)
    [void][IO.Directory]::CreateDirectory($scratch)
    $name = "$($config.productName)_$($config.version)_x64"
    $cli = 'node_modules/@tauri-apps/cli/tauri.js'

    # Tauri's static VC runtime setting does not reach cc-based C++ dependencies.
    # UnRAR must also use /MT so a single-file release does not need MSVCP140.dll.
    $env:CXXFLAGS_x86_64_pc_windows_msvc = ($previousCxxFlags + ' /MT').Trim()
    # Compile once. The executable selects a sibling WebView2 folder at startup.
    Invoke-Checked -File 'node.exe' -Arguments @($cli, 'build', '--no-bundle', '--ci', '--target', $target, '--', '--locked')
    if (-not (Test-Path -LiteralPath $binary)) { throw "Missing build output: $binary" }
    Assert-StandaloneExecutable -Path $binary
    $artifacts = @()

    if ('single' -in $modes) {
        $destination = Join-Path $output "${name}_single.exe"
        $single = Join-Path $scratch "${name}_single.exe"
        if ($NoExeCompression) {
            Copy-Item -LiteralPath $binary -Destination $single
        } else {
            Compress-SingleExecutable -Source $binary -Destination $single -CacheRoot $toolCache
        }
        Move-Item -LiteralPath $single -Destination $destination -Force
        $artifacts += $destination
        Write-Host "Single executable: $destination"
    }

    if ('portable' -in $modes) {
        $runtime = Get-FixedWebView2 -CacheRoot (Join-Path $PSScriptRoot '.runtime\packaging\webview2\x64') -Directory $WebView2Path -Version $WebView2Version
        $stage = Join-Path $scratch "${name}_portable"
        [void][IO.Directory]::CreateDirectory($stage)
        Copy-Item -LiteralPath $binary -Destination (Join-Path $stage "$($config.mainBinaryName).exe")
        Copy-Item -LiteralPath $runtime.Path -Destination (Join-Path $stage 'WebView2') -Recurse
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE') -Destination $stage
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'UNRAR-LICENSE.txt') -Destination $stage
        $info = [ordered]@{ appVersion = $config.version; architecture = 'x64'; webview2Version = $runtime.Version; webview2Source = $runtime.Source }
        [IO.File]::WriteAllText((Join-Path $stage 'runtime-info.json'), ($info | ConvertTo-Json))
        $instructions = @'
SFMCL-T portable (Windows 10/11 x64)

Extract the ENTIRE archive to a writable local directory, then run SFMCL-T.exe.
Use 7-Zip for .7z files on Windows versions without native 7z support.
Keep the WebView2 folder beside the executable. It is used automatically and
does not install or modify the system WebView2 Runtime.
At startup, Windows AppContainer read/execute permissions are granted to this
bundled runtime directory, as required by Microsoft on Windows 10.

Configuration uses the system application-data directory by default.
SFMCL_T_DATA_DIR can override it. Java is not bundled; configure a compatible
Java version in the launcher's game settings.

The fixed WebView2 runtime does not auto-update. Rebuild this package with a
new -WebView2Version or -WebView2Path when distributing an update.
'@
        [IO.File]::WriteAllText((Join-Path $stage 'README.txt'), $instructions)
        $archive = Join-Path $scratch "${name}_portable.$PortableFormat"
        Write-Host "Compressing portable $PortableFormat package with WebView2 $($runtime.Version)..."
        Compress-PortableDirectory -Directory $stage -Destination $archive -Format $PortableFormat -CacheRoot $toolCache
        $destination = Join-Path $output "${name}_portable.$PortableFormat"
        Move-Item -LiteralPath $archive -Destination $destination -Force
        $artifacts += $destination
    }

    if ('installer' -in $modes) {
        Invoke-Checked -File 'node.exe' -Arguments @($cli, 'bundle', '--bundles', 'nsis', '--ci', '--target', $target)
        $setup = Join-Path $binaryDirectory "bundle\nsis\$($config.productName)_$($config.version)_x64-setup.exe"
        if (-not (Test-Path -LiteralPath $setup)) { throw "NSIS did not produce the expected installer: $setup" }
        $destination = Join-Path $output "${name}_installer.exe"
        Copy-Item -LiteralPath $setup -Destination $destination -Force
        $artifacts += $destination
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
    $env:CXXFLAGS_x86_64_pc_windows_msvc = $previousCxxFlags
    if ($scratch) {
        Remove-PackagingScratch -Path $scratch -Root (Join-Path $PSScriptRoot '.runtime\packaging\runs')
    }
    Pop-Location
}
