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
    param([switch]$WebOnly, [switch]$RequireWebView2)
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
    $targets = & rustup.exe target list --installed
    if ($LASTEXITCODE -ne 0 -or 'x86_64-pc-windows-msvc' -notin $targets) {
        throw 'Missing Rust target. Run: rustup target add x86_64-pc-windows-msvc'
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw 'Install Visual Studio C++ Build Tools with Desktop development with C++ and Windows 10/11 SDK.'
    }
    $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $visualStudio) { throw 'The Visual Studio MSVC x64/x86 build tools are missing.' }
    $sdkLibraries = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Lib\*\um\x64\kernel32.lib'
    if (-not (Test-Path -Path $sdkLibraries)) { throw 'Install the Windows 10/11 SDK in Visual Studio Installer.' }
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

function Assert-StandaloneExecutable {
    param([string]$Path)
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
