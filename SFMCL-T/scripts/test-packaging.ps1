#requires -Version 5.1
# Exercise the real NSIS environment page with isolated registry fixtures.
# No system WebView2 keys are changed and no runtime/app installation is performed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$project = Split-Path -Parent $PSScriptRoot
$workspace = Split-Path -Parent $project
$nsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path -LiteralPath $nsis)) { throw 'Build an installer first so Tauri can prepare NSIS.' }
$id = [guid]::NewGuid().ToString('N')
$fixtureKey = "SOFTWARE\SFMCL-T-PackagingTest-$id"
$testRoot = Join-Path $workspace ".runtime\packaging\installer-tests\$id"
$evidence = Join-Path $workspace '.runtime\packaging\evidence'
[void][IO.Directory]::CreateDirectory($testRoot)
[void][IO.Directory]::CreateDirectory($evidence)

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
public static class PackagingWindow {
    public delegate bool EnumCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr handle, int id);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rectangle);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
    public static IntPtr Find(int processId) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, unused) => {
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (owner == processId) { found = window; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static IntPtr Checkbox(IntPtr parent) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(parent, (window, unused) => {
            var text = new StringBuilder(512); var className = new StringBuilder(64);
            GetWindowText(window, text, text.Capacity); GetClassName(window, className, className.Capacity);
            if (className.ToString() == "Button" && text.ToString().Contains("Microsoft WebView2 Runtime")) {
                found = window; return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool Checked(IntPtr checkbox) {
        return SendMessage(checkbox, 0x00F0, IntPtr.Zero, IntPtr.Zero).ToInt64() == 1;
    }
    public static void Click(IntPtr control) { PostMessage(control, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
    public static void Capture(IntPtr window, string path) {
        // Paint off-screen without activating a window on the user's desktop.
        SetWindowPos(window, IntPtr.Zero, -10000, -10000, 0, 0, 0x0015);
        ShowWindow(window, 8);
        Rect r; GetWindowRect(window, out r);
        using (var bitmap = new Bitmap(r.Right - r.Left, r.Bottom - r.Top)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                var dc = graphics.GetHdc();
                try { PrintWindow(window, dc, 2); } finally { graphics.ReleaseHdc(dc); }
            }
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
'@

function Clear-Fixture {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try { $base.DeleteSubKeyTree($fixtureKey, $false) } finally { $base.Dispose() }
    }
}

function Wait-Checkbox {
    param([int]$ProcessId)
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $window = [PackagingWindow]::Find($ProcessId)
        $checkbox = [PackagingWindow]::Checkbox($window)
        if ($checkbox -ne [IntPtr]::Zero) { return [pscustomobject]@{ Window = $window; Checkbox = $checkbox } }
        Start-Sleep -Milliseconds 100
    }
    throw 'Installer environment page did not appear.'
}

try {
    $hook = (Join-Path $project 'src-tauri\installer\webview2-hooks.nsh').Replace('$', '$$')
    $executable = Join-Path $testRoot 'environment-page.exe'
    $template = @'
Unicode true
!include MUI2.nsh
Name "SFMCL-T packaging test"
OutFile "@OUTPUT@"
RequestExecutionLevel user
InstallDir "$TEMP\SFMCL-T-PackagingTest"
!define SFMCL_T_WEBVIEW_REGKEY "@REGISTRY@"
!include "@HOOK@"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Section
  ; /S exercises the same initialization used by the real installation hook.
  Call SFMCLTInitializeWebViewChoice
  FileOpen $0 "$EXEDIR\silent-state.txt" w
  FileWrite $0 "$SFMCLTWebViewSelected|$SFMCLTWebViewVersion"
  FileClose $0
SectionEnd
'@
    $source = $template.Replace('@OUTPUT@', $executable.Replace('$', '$$')).Replace('@REGISTRY@', $fixtureKey).Replace('@HOOK@', $hook)
    $nsi = Join-Path $testRoot 'environment-page.nsi'
    [IO.File]::WriteAllText($nsi, $source, [Text.UTF8Encoding]::new($false))
    Invoke-Checked -File $nsis -Arguments @('/V2', '/INPUTCHARSET', 'UTF8', $nsi)
    $results = @()
    $cases = @(
        @{ Name = 'missing'; Version = ''; View = 'Registry32'; Checked = $true; Enabled = $true },
        @{ Name = 'zero-version'; Version = '0.0.0.0'; View = 'Registry32'; Checked = $true; Enabled = $true },
        @{ Name = 'installed-user32'; Version = '155.0.4283.45'; View = 'Registry32'; Checked = $false; Enabled = $false },
        @{ Name = 'installed-user64'; Version = '154.0.4258.62'; View = 'Registry64'; Checked = $false; Enabled = $false }
    )
    foreach ($case in $cases) {
        Clear-Fixture
        if ($case.Version) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]$case.View)
            $key = $base.CreateSubKey($fixtureKey)
            try { $key.SetValue('pv', $case.Version) } finally { $key.Dispose(); $base.Dispose() }
        }
        $process = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru
        try {
            $page = Wait-Checkbox -ProcessId $process.Id
            $checked = [PackagingWindow]::Checked($page.Checkbox)
            $enabled = [PackagingWindow]::IsWindowEnabled($page.Checkbox)
            if ($checked -ne $case.Checked -or $enabled -ne $case.Enabled) {
                throw "$($case.Name): checkbox state is checked=$checked, enabled=$enabled"
            }
            [PackagingWindow]::Capture($page.Window, (Join-Path $evidence "$($case.Name).png"))
            if ($case.Enabled) {
                [PackagingWindow]::Click($page.Checkbox)
                Start-Sleep -Milliseconds 150
                if ([PackagingWindow]::Checked($page.Checkbox)) { throw 'The user cannot uncheck the environment option.' }
                [PackagingWindow]::Click([PackagingWindow]::GetDlgItem($page.Window, 1))
                Start-Sleep -Milliseconds 250
                [PackagingWindow]::Click([PackagingWindow]::GetDlgItem($page.Window, 3))
                Start-Sleep -Milliseconds 250
                $page = Wait-Checkbox -ProcessId $process.Id
                if ([PackagingWindow]::Checked($page.Checkbox)) { throw 'Navigating back reset the user selection.' }
            }
        } finally {
            if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
            $process.Dispose()
        }
        $silentProcess = Start-Process -FilePath $executable -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
        try {
            if ($silentProcess.ExitCode -ne 0) { throw 'Silent environment detection failed.' }
            $silentState = Get-Content -LiteralPath (Join-Path $testRoot 'silent-state.txt') -Raw
            $expectedSelection = if ($case.Checked) { '1' } else { '0' }
            if (-not $silentState.StartsWith("$expectedSelection|")) { throw "Incorrect silent selection: $silentState" }
        } finally { $silentProcess.Dispose() }
        $results += [pscustomobject]@{ case = $case.Name; checked = $checked; enabled = $enabled; silent = $true; passed = $true }
        Write-Host "$($case.Name): interactive and silent checks passed"
    }
    $config = Get-Content -LiteralPath (Join-Path $project 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
    $installer = Join-Path $workspace "release\$($config.productName)_$($config.version)_x64_installer.exe"
    if (Test-Path -LiteralPath $installer) {
        # Run a snapshot so another build can replace the released installer.
        $installerSnapshot = Join-Path $testRoot 'generated-installer.exe'
        Copy-Item -LiteralPath $installer -Destination $installerSnapshot
        $systemVersion = Get-InstalledWebView2Version
        $process = Start-Process -FilePath $installerSnapshot -WindowStyle Hidden -PassThru
        try {
            $page = Wait-Checkbox -ProcessId $process.Id
            $expected = -not [bool]$systemVersion
            if ([PackagingWindow]::Checked($page.Checkbox) -ne $expected -or
                [PackagingWindow]::IsWindowEnabled($page.Checkbox) -ne $expected) {
                throw 'The generated installer does not reflect the actual machine environment.'
            }
            [PackagingWindow]::Capture($page.Window, (Join-Path $evidence 'generated-installer.png'))
            $results += [pscustomobject]@{ case = 'generated-installer'; systemVersion = $systemVersion; sha256 = (Get-FileHash -LiteralPath $installerSnapshot -Algorithm SHA256).Hash; passed = $true }
            Write-Host 'Generated installer: actual machine detection passed'
        } finally {
            # Stop on the first page; do not perform a real application installation.
            if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
            $process.Dispose()
        }
    }
    [IO.File]::WriteAllText((Join-Path $evidence 'installer-checks.json'), ($results | ConvertTo-Json))
} finally {
    Clear-Fixture
    Remove-PackagingScratch -Path $testRoot -Root (Join-Path $workspace '.runtime\packaging\installer-tests')
}
