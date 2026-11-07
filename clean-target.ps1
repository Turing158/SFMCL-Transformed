#requires -Version 5.1
<#
.SYNOPSIS
Remove temporary output, optionally pruning compiler and test caches.
.EXAMPLE
.\clean-target.ps1 -WhatIf
.EXAMPLE
.\clean-target.ps1
.EXAMPLE
.\clean-target.ps1 -PruneBuildCache -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param([switch]$PruneBuildCache)

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

# Enumerate one level at a time so links are rejected before descent.
function Get-UnlinkedTree {
    param([System.IO.FileSystemInfo]$Entry)
    $pending = New-Object 'System.Collections.Generic.Stack[System.IO.FileSystemInfo]'
    $pending.Push($Entry)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $resolved = [IO.Path]::GetFullPath($current.FullName)
        if (-not $resolved.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to inspect a path outside target: $resolved"
        }
        if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to inspect a symbolic link or junction: $resolved"
        }
        $current
        if ($current -is [IO.DirectoryInfo]) {
            foreach ($child in $current.GetFileSystemInfos()) { $pending.Push($child) }
        }
    }
}

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
$cleanupPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$locks = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
$removed = 0
function Add-CleanupPath {
    param([string]$Path)
    if ((Test-Path -LiteralPath $Path) -and $cleanupPaths.Add([IO.Path]::GetFullPath($Path))) {
        $cleanup.Add((Get-Item -LiteralPath $Path -Force))
    }
}
try {
    # Acquire every build lock before collecting or deleting any output.
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
    }
    foreach ($profile in $profiles) {
        # Default mode preserves reusable build output. Explicit pruning retains
        # dependency libraries, build-script output, desktop binaries and bundles.
        # Only expired loose temporary files are eligible inside a profile.
        foreach ($entry in Get-ChildItem -LiteralPath $profile.FullName -File -Force) {
            if ($entry.Extension -in @('.tmp', '.temp') -and $entry.LastWriteTime -lt $temporaryCutoff) {
                Add-CleanupPath -Path $entry.FullName
            }
        }
        if (-not $PruneBuildCache) { continue }
        $incrementalRoot = Join-Path $profile.FullName 'incremental'
        if (Test-Path -LiteralPath $incrementalRoot) {
            $incrementalDirectory = Get-Item -LiteralPath $incrementalRoot -Force
            if ($incrementalDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to inspect linked incremental output: $incrementalRoot"
            }
            foreach ($entry in $incrementalDirectory.GetFileSystemInfos()) {
                Add-CleanupPath -Path $entry.FullName
            }
        }
        $fingerprintRoot = Join-Path $profile.FullName '.fingerprint'
        if (-not (Test-Path -LiteralPath $fingerprintRoot)) { continue }
        $fingerprintDirectory = Get-Item -LiteralPath $fingerprintRoot -Force
        if ($fingerprintDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to inspect linked fingerprints: $fingerprintRoot"
        }
        foreach ($name in @('deps', 'examples')) {
            $artifactDirectory = Join-Path $profile.FullName $name
            if ((Test-Path -LiteralPath $artifactDirectory) -and
                ((Get-Item -LiteralPath $artifactDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Refusing to inspect linked artifacts: $artifactDirectory"
            }
        }
        # Cargo fingerprints identify test/example units. Never infer disposable
        # output from an extension alone: ordinary library units stay untouched.
        foreach ($unit in $fingerprintDirectory.GetDirectories()) {
            if ($unit.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to inspect a linked fingerprint: $($unit.FullName)"
            }
            if ($unit.Name -notmatch '-([0-9a-f]{16})$') { continue }
            $hash = $Matches[1]
            foreach ($marker in $unit.GetFiles('*.json')) {
                if ($marker.Name -notmatch '^(test-(?:lib|bin|integration-test|example)|example)-(.+)\.json$') { continue }
                $kind = $Matches[1]
                $binaryName = $Matches[2].Replace('-', '_')
                $artifactRoot = Join-Path $profile.FullName 'deps'
                if ($kind -in @('example', 'test-example')) {
                    $artifactRoot = Join-Path $profile.FullName 'examples'
                }
                foreach ($extension in @('.exe', '.pdb', '.d')) {
                    Add-CleanupPath -Path (Join-Path $artifactRoot ($binaryName + '-' + $hash + $extension))
                    if ($kind -eq 'example') {
                        Add-CleanupPath -Path (Join-Path $artifactRoot ($binaryName + $extension))
                    }
                }
                if ($kind -eq 'example') {
                    Add-CleanupPath -Path (Join-Path $artifactRoot ('lib' + $binaryName + '-' + $hash + '.rmeta'))
                }
                Add-CleanupPath -Path $unit.FullName
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
                $contents = @(Get-UnlinkedTree -Entry $entry)
                $recent = $contents | Where-Object { $_.LastWriteTime -ge $temporaryCutoff } | Select-Object -First 1
                if ($recent) { continue }
            }
            Add-CleanupPath -Path $entry.FullName
        }
    }

    # Validate the entire deletion set before removing anything.
    $plannedBytes = [long]0
    foreach ($entry in $cleanup) {
        $resolved = (Resolve-Path -LiteralPath $entry.FullName).ProviderPath
        if (-not $resolved.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a path outside target: $resolved"
        }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to remove a symbolic link or junction: $resolved"
        }
        foreach ($content in Get-UnlinkedTree -Entry $entry) {
            if ($content -is [IO.FileInfo]) { $plannedBytes += $content.Length }
        }
    }
    # A desktop app may keep running after Cargo finishes building. Preserve it,
    # and refuse pruning if a selected test/example program is still executing.
    if ($PruneBuildCache -and $cleanup.Count -gt 0) {
        foreach ($process in Get-CimInstance Win32_Process) {
            if (-not $process.ExecutablePath -or
                -not $process.ExecutablePath.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
            foreach ($entry in $cleanup) {
                if ($process.ExecutablePath.Equals($entry.FullName, [StringComparison]::OrdinalIgnoreCase) -or
                    ($entry.PSIsContainer -and $process.ExecutablePath.StartsWith($entry.FullName.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
                    throw "Finish the selected test/example before cleaning: $($process.Name) (PID $($process.ProcessId))"
                }
            }
        }
    }
    foreach ($entry in $cleanup) {
        if ($PSCmdlet.ShouldProcess($entry.FullName, 'Remove disposable temporary/compiler/test output')) {
            Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $entry.FullName) { throw "Cleanup entry still exists: $($entry.FullName)" }
            $removed++
        }
    }
    Write-Host ("Target cleanup: {0} of {1} entries removed; selected file data: {2:N2} GiB. Desktop binaries, dependency libraries, build output and bundles retained." -f $removed, $cleanup.Count, ($plannedBytes / 1GB))
} finally {
    foreach ($lock in $locks) { $lock.Dispose() }
}
