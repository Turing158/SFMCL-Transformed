# Shared by dev.ps1 and build.ps1. Compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest
# A .cmd/npm parent can pass PowerShell 7's module path into Windows PowerShell.
# Import the running engine's modules explicitly, including its Get-FileHash function.
foreach ($moduleName in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules\$moduleName\$moduleName.psd1") -ErrorAction Stop
}

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments = @())
    & $File @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "$File failed (exit code $LASTEXITCODE)."
    }
}

function Get-AvailableDevelopmentPort {
    param([ValidateRange(1024, 65535)][int]$PreferredPort = 1420)
    # Vite binds IPv4 loopback. ExclusiveAddressUse also detects wildcard
    # listeners and Windows-reserved ports without stopping their owners.
    $lastPort = [Math]::Min(65535, $PreferredPort + 99)
    for ($candidate = $PreferredPort; $candidate -le $lastPort; $candidate++) {
        $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        try {
            $probe.Server.ExclusiveAddressUse = $true
            $probe.Start()
            if ($candidate -ne $PreferredPort) {
                Write-Host "Development port $PreferredPort is unavailable; using $candidate instead."
            }
            return $candidate
        } catch [Net.Sockets.SocketException] {
            if ($_.Exception.SocketErrorCode -notin @(
                [Net.Sockets.SocketError]::AddressAlreadyInUse,
                [Net.Sockets.SocketError]::AccessDenied
            )) { throw }
        } finally {
            $probe.Stop()
        }
    }
    throw "No development port is available between $PreferredPort and $lastPort. Choose another range with -Port."
}

function Remove-PackagingScratch {
    param([string]$Path, [string]$Root)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $boundary = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $item = Get-Item -LiteralPath $Path
    $resolved = [IO.Path]::GetFullPath($item.FullName)
    if (-not $resolved.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase) -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to clean a directory outside the packaging scratch root: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Get-InstalledWebView2Version {
    $subkey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            $key = $null
            try {
                $key = $base.OpenSubKey($subkey)
                if ($key) {
                    $version = $null
                    if ([version]::TryParse([string]$key.GetValue('pv'), [ref]$version) -and $version -gt [version]'0.0.0.0') {
                        return $version.ToString()
                    }
                }
            } finally {
                if ($key) { $key.Dispose() }
                $base.Dispose()
            }
        }
    }
    return $null
}

function Assert-DevelopmentTools {
    param(
        [switch]$WebOnly,
        [switch]$RequireWebView2,
        [ValidateSet('x86_64-pc-windows-msvc', 'i686-pc-windows-msvc')]
        [string[]]$Targets = @('x86_64-pc-windows-msvc')
    )
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'These scripts target Windows 10/11 x64.'
    }
    foreach ($command in @('node.exe', 'npm.cmd')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Missing $command. Install Node.js LTS: https://nodejs.org/"
        }
    }
    $nodeVersion = [version]((& node.exe --version).Trim().TrimStart('v'))
    if (-not (($nodeVersion.Major -eq 20 -and $nodeVersion -ge [version]'20.19.0') -or $nodeVersion -ge [version]'22.12.0')) {
        throw "Node.js $nodeVersion is unsupported. Vite needs 20.19+ or 22.12+."
    }
    Write-Host "Node.js $nodeVersion"
    if ($WebOnly) { return }

    foreach ($command in @('cargo.exe', 'rustc.exe', 'rustup.exe')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Missing $command. Install Rust with the MSVC toolchain: https://rustup.rs/"
        }
    }
    $installedTargets = & rustup.exe target list --installed
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read installed Rust targets.' }
    foreach ($target in $Targets) {
        if ($target -notin $installedTargets) {
            throw "Missing Rust target. Run: rustup target add $target"
        }
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw 'Install Visual Studio C++ Build Tools with Desktop development with C++ and Windows 10/11 SDK.'
    }
    $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $visualStudio) { throw 'The Visual Studio MSVC x64/x86 build tools are missing.' }
    foreach ($target in $Targets) {
        $sdkArchitecture = if ($target -eq 'i686-pc-windows-msvc') { 'x86' } else { 'x64' }
        $sdkLibraries = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Lib\*\um\$sdkArchitecture\kernel32.lib"
        if (-not (Test-Path -Path $sdkLibraries)) {
            throw "Install the Windows 10/11 SDK with $sdkArchitecture libraries in Visual Studio Installer."
        }
    }
    Write-Host "MSVC build tools: $visualStudio"

    $webviewVersion = Get-InstalledWebView2Version
    if ($webviewVersion) {
        Write-Host "WebView2 $webviewVersion"
    } elseif ($RequireWebView2) {
        throw 'WebView2 Runtime is missing. Install it from https://developer.microsoft.com/microsoft-edge/webview2/'
    } else {
        Write-Host 'System WebView2 is absent; it is not needed to compile packages.'
    }
}

function Sync-NodeDependencies {
    param([string]$ProjectRoot, [switch]$Force)
    $lock = Join-Path $ProjectRoot 'package-lock.json'
    $stamp = Join-Path $ProjectRoot 'node_modules\.sfmcl-t-lock.sha256'
    $lockHash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash
    $installedHash = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }
    $tauri = Join-Path $ProjectRoot 'node_modules\@tauri-apps\cli\tauri.js'
    $vite = Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'
    if ($Force -or $installedHash -ne $lockHash -or -not (Test-Path -LiteralPath $tauri) -or -not (Test-Path -LiteralPath $vite)) {
        Write-Host 'Installing locked Node.js dependencies...'
        Invoke-Checked -File 'npm.cmd' -Arguments @('ci', '--no-audit', '--no-fund')
        [IO.File]::WriteAllText($stamp, $lockHash)
    }
}

function Get-CargoTargetDirectory {
    param([string]$WorkspaceRoot)
    if ($env:CARGO_TARGET_DIR) {
        return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:CARGO_TARGET_DIR)
    }
    return (Join-Path $WorkspaceRoot 'target')
}

function Repair-StaleCargoCache {
    <#
    .SYNOPSIS
    Move aside Cargo build units whose recorded absolute paths point elsewhere.
    .DESCRIPTION
    Build scripts print absolute paths into target\...\build\<crate>\output and
    Cargo replays that output while the fingerprint stays valid. Renaming or
    copying a workspace therefore leaves entries such as
    target\...\build\tauri-<hash>\out\... pointing at the old location, which
    breaks Tauri ACL generation with "failed to read plugin permissions".
    Cargo cannot invalidate a single unit, so the affected build directories and
    their fingerprints are moved to .runtime\cargo-stale\<timestamp> and built
    again by this run. Nothing is deleted.
    #>
    param([string]$WorkspaceRoot)
    $targetDirectory = Get-CargoTargetDirectory -WorkspaceRoot $WorkspaceRoot
    if (-not (Test-Path -LiteralPath $targetDirectory)) { return }
    $prefix = [IO.Path]::GetFullPath($targetDirectory).TrimEnd('\') + '\'
    $profileDirectories = New-Object System.Collections.Generic.List[object]
    foreach ($entry in @(Get-ChildItem -LiteralPath $targetDirectory -Directory -ErrorAction SilentlyContinue)) {
        if ($entry.Name -eq 'debug' -or $entry.Name -eq 'release') {
            $profileDirectories.Add($entry)
            continue
        }
        # Target triple directories such as x86_64-pc-windows-msvc (four or more parts).
        if ($entry.Name -notmatch '^[A-Za-z0-9_]+(-[A-Za-z0-9_]+){2,}$') { continue }
        foreach ($inner in @(Get-ChildItem -LiteralPath $entry.FullName -Directory -ErrorAction SilentlyContinue)) {
            if ($inner.Name -eq 'debug' -or $inner.Name -eq 'release') { $profileDirectories.Add($inner) }
        }
    }
    # Recorded paths are matched on the target directory's own name, which is
    # normally "target" but follows CARGO_TARGET_DIR when that is set. The
    # character classes stop at the separators build scripts use to join paths
    # (quotes and semicolons), so one line can carry several paths.
    $targetSegment = [regex]::Escape('\' + (Split-Path -Leaf $targetDirectory) + '\')
    $recordedPathPattern = '(?im)\b[A-Za-z]:\\[^"''\r\n;]*?' + $targetSegment + '[^"''\r\n;]*'
    $staleUnits = New-Object System.Collections.Generic.List[object]
    try {
        foreach ($profile in $profileDirectories) {
            $buildRoot = Join-Path $profile.FullName 'build'
            if (-not (Test-Path -LiteralPath $buildRoot)) { continue }
            foreach ($unit in @(Get-ChildItem -LiteralPath $buildRoot -Directory -ErrorAction SilentlyContinue)) {
                $output = Join-Path $unit.FullName 'output'
                if (-not (Test-Path -LiteralPath $output)) { continue }
                foreach ($recorded in [regex]::Matches([IO.File]::ReadAllText($output), $recordedPathPattern)) {
                    if ($recorded.Value.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
                    $staleUnits.Add($unit)
                    break
                }
            }
        }
    } catch {
        throw "Cannot inspect the Cargo cache (is a build still running?): $($_.Exception.Message)"
    }
    if ($staleUnits.Count -eq 0) { return }
    $quarantineRoot = Join-Path $WorkspaceRoot ('.runtime\cargo-stale\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        foreach ($unit in $staleUnits) {
            $destination = Join-Path $quarantineRoot $unit.FullName.Substring($prefix.Length)
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
            Move-Item -LiteralPath $unit.FullName -Destination $destination -Force
            # The fingerprint must go too, or Cargo keeps replaying the cached output.
            $fingerprint = Join-Path (Split-Path -Parent (Split-Path -Parent $unit.FullName)) ('.fingerprint\' + $unit.Name)
            if (Test-Path -LiteralPath $fingerprint) {
                $fingerprintDestination = Join-Path $quarantineRoot $fingerprint.Substring($prefix.Length)
                [void][IO.Directory]::CreateDirectory((Split-Path -Parent $fingerprintDestination))
                Move-Item -LiteralPath $fingerprint -Destination $fingerprintDestination -Force
            }
        }
    } catch {
        throw "Cannot reset stale Cargo cache entries (is a build still running?): $($_.Exception.Message)"
    }
    Write-Host "Cargo cache held $($staleUnits.Count) build unit(s) from another workspace path."
    Write-Host "Moved them to $quarantineRoot; they are rebuilt now."
}

function Get-ExecutableArchitecture {
    param([string]$Path)
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Path))
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Not a Windows executable: $Path" }
        $reader.BaseStream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 64 -or $peOffset -gt $reader.BaseStream.Length - 6) {
            throw "Invalid PE header offset: $Path"
        }
        $reader.BaseStream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x4550) { throw "Invalid PE signature: $Path" }
        switch ($reader.ReadUInt16()) {
            0x014c { return 'x86' }
            0x8664 { return 'x64' }
            default { throw "Unsupported executable architecture: $Path" }
        }
    } finally { $reader.Dispose() }
}

function Assert-StandaloneExecutable {
    param([string]$Path, [ValidateSet('x64', 'x86')][string]$Architecture = 'x64')
    if ((Get-ExecutableArchitecture -Path $Path) -ne $Architecture) {
        throw "The executable does not match the requested $Architecture architecture: $Path"
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $dumpbin = Get-ChildItem -Path (Join-Path $visualStudio 'VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe') |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $dumpbin) { throw 'Cannot find dumpbin.exe to check single-file dependencies.' }
    $dependencies = & $dumpbin.FullName /NOLOGO /DEPENDENTS $Path
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the application executable.' }
    if ($dependencies -match '(?i)(VCRUNTIME\d*[^\s]*|MSVCP\d+[^\s]*|MSVCR\d+[^\s]*|WebView2Loader)\.dll') {
        throw 'The application still imports a redistributable DLL. Check static VC runtime/WebView2 loader linking.'
    }
}
