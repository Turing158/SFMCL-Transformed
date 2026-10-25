#requires -Version 5.1
<#
.SYNOPSIS
Start the SFMCL-T desktop development server, or use -Web for browser preview.
.EXAMPLE
.\dev.ps1
.EXAMPLE
.\dev.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Web,
    [switch]$Check,
    [switch]$InstallDependencies,
    [string]$DataDir,
    [ValidateRange(1024, 65535)]
    [int]$Port = 1420
)
$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $PSScriptRoot 'SFMCL-T'
. (Join-Path $projectRoot 'scripts\windows-common.ps1')
$previousDataDir = $env:SFMCL_T_DATA_DIR
$previousOutputEncoding = [Console]::OutputEncoding
$devConfig = $null
Push-Location -LiteralPath $PSScriptRoot
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if (-not $env:SFMCL_T_DATA_DIR -and $env:TMCL_DATA_DIR) {
        $env:SFMCL_T_DATA_DIR = $env:TMCL_DATA_DIR
    }
    Assert-DevelopmentTools -WebOnly:$Web -RequireWebView2:(-not $Web)
    if ($Check) {
        Write-Host 'Development prerequisites OK.'
        exit 0
    }
    if ($DataDir) {
        $DataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
    } elseif ($env:SFMCL_T_DATA_DIR) {
        $env:SFMCL_T_DATA_DIR = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:SFMCL_T_DATA_DIR)
    }
    Set-Location -LiteralPath $projectRoot
    Sync-NodeDependencies -ProjectRoot $projectRoot -Force:$InstallDependencies
    if ($Web) {
        Invoke-Checked -File 'npm.cmd' -Arguments @('run', 'dev', '--', '--port', [string]$Port)
    } else {
        if ($DataDir) {
            $env:SFMCL_T_DATA_DIR = $DataDir
        } elseif (-not $env:SFMCL_T_DATA_DIR) {
            $env:SFMCL_T_DATA_DIR = Join-Path $PSScriptRoot '.runtime\dev-data'
        }
        Write-Host "Development data: $env:SFMCL_T_DATA_DIR"
        $devConfigRoot = Join-Path $PSScriptRoot '.runtime\dev'
        [void][IO.Directory]::CreateDirectory($devConfigRoot)
        $devConfig = Join-Path $devConfigRoot ('tauri-' + [guid]::NewGuid().ToString('N') + '.json')
        $overrides = @{ build = @{ beforeDevCommand = "npm run dev -- --port $Port"; devUrl = "http://127.0.0.1:$Port" } }
        [IO.File]::WriteAllText($devConfig, ($overrides | ConvertTo-Json -Depth 4))
        Invoke-Checked -File 'node.exe' -Arguments @('node_modules/@tauri-apps/cli/tauri.js', 'dev', '--target', 'x86_64-pc-windows-msvc', '--config', $devConfig)
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    [Console]::OutputEncoding = $previousOutputEncoding
    $env:SFMCL_T_DATA_DIR = $previousDataDir
    if ($devConfig -and (Test-Path -LiteralPath $devConfig)) { Remove-Item -LiteralPath $devConfig -Force }
    Pop-Location
}
