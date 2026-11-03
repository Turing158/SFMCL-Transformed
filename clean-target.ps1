#requires -Version 5.1
<#
.SYNOPSIS
Remove expired temporary output while preserving development and packaging files.
.EXAMPLE
.\clean-target.ps1 -WhatIf
.EXAMPLE
.\clean-target.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = Join-Path $PSScriptRoot 'SFMCL-T'
$expectedTarget = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'target'))
if (-not (Test-Path -LiteralPath $expectedTarget)) {
    Write-Host 'No Cargo target directory to clean.'
    return
}

foreach ($directory in @($PSScriptRoot, $workspaceRoot, $expectedTarget)) {
    if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to clean through a symbolic link or junction: $directory"
    }
}
$targetRoot = (Resolve-Path -LiteralPath $expectedTarget).ProviderPath
if (-not $targetRoot.Equals($expectedTarget, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unexpected target directory: $targetRoot"
}
$targetPrefix = $targetRoot.TrimEnd('\') + '\'
$temporaryCutoff = (Get-Date).AddDays(-1)

# Cargo profiles live directly under target or under a compilation target triple.
$profiles = @(
    foreach ($entry in Get-ChildItem -LiteralPath $targetRoot -Directory -Force) {
        if ($entry.Name -in @('debug', 'release')) {
            $entry
        } elseif ($entry.Name -match '^[A-Za-z0-9_]+(-[A-Za-z0-9_]+){2,}$') {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to inspect a linked target directory: $($entry.FullName)"
            }
            Get-ChildItem -LiteralPath $entry.FullName -Directory -Force |
                Where-Object { $_.Name -in @('debug', 'release') }
        }
    }
)
$cleanup = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
$locks = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
$removed = 0
try {
    foreach ($profile in $profiles) {
        if ($profile.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to inspect a linked profile: $($profile.FullName)"
        }
        # Holding all Cargo locks prevents a build from starting during cleanup.
        foreach ($name in @('.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock')) {
            $lockPath = Join-Path $profile.FullName $name
            if ((Test-Path -LiteralPath $lockPath) -and
                ((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Refusing to open a linked Cargo lock: $lockPath"
            }
            try {
                $locks.Add([IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None))
            } catch {
                throw "Cannot lock Cargo output. Finish builds/tests before cleaning: $lockPath"
            }
        }
        # Keep all reusable build output: fingerprints, dependencies, build-script
        # output, incremental state, libraries, symbols, resources and bundles.
        # Only expired loose temporary files are eligible inside a profile.
        foreach ($entry in Get-ChildItem -LiteralPath $profile.FullName -File -Force) {
            if ($entry.Extension -in @('.tmp', '.temp') -and $entry.LastWriteTime -lt $temporaryCutoff) {
                $cleanup.Add($entry)
            }
        }
    }
    # Cargo's test scratch directory may contain recent or still-needed output.
    # Keep the directory itself, and retain a child if any of its content is recent.
    $temporaryRoot = Join-Path $targetRoot 'tmp'
    if (Test-Path -LiteralPath $temporaryRoot) {
        $temporaryDirectory = Get-Item -LiteralPath $temporaryRoot -Force
        if ($temporaryDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to inspect a linked temporary directory: $temporaryRoot"
        }
        foreach ($entry in Get-ChildItem -LiteralPath $temporaryRoot -Force) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to inspect a linked temporary entry: $($entry.FullName)"
            }
            if ($entry.LastWriteTime -ge $temporaryCutoff) { continue }
            if ($entry.PSIsContainer) {
                $contents = @(Get-ChildItem -LiteralPath $entry.FullName -Recurse -Force)
                $linked = $contents | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
                if ($linked) { throw "Refusing to inspect temporary content containing a link: $($linked.FullName)" }
                $recent = $contents | Where-Object { $_.LastWriteTime -ge $temporaryCutoff } | Select-Object -First 1
                if ($recent) { continue }
            }
            $cleanup.Add($entry)
        }
    }

    # Validate the entire deletion set before removing anything.
    foreach ($entry in $cleanup) {
        $resolved = (Resolve-Path -LiteralPath $entry.FullName).ProviderPath
        if (-not $resolved.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a path outside target: $resolved"
        }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to remove a symbolic link or junction: $resolved"
        }
        if ($entry.PSIsContainer) {
            $linked = Get-ChildItem -LiteralPath $resolved -Recurse -Force |
                Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
                Select-Object -First 1
            if ($linked) { throw "Refusing to remove a directory containing a link: $($linked.FullName)" }
        }
    }
    foreach ($entry in $cleanup) {
        if ($PSCmdlet.ShouldProcess($entry.FullName, 'Remove expired temporary output')) {
            Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction Stop
            $removed++
        }
    }
    Write-Host "Target cleanup: $removed of $($cleanup.Count) expired temporary entries removed. Development/packaging files and reusable build caches retained."
} finally {
    foreach ($lock in $locks) { $lock.Dispose() }
}
