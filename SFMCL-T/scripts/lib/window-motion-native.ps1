param(
    [Parameter(Mandatory)][int]$LauncherProcessId,
    [Parameter(Mandatory)][string]$ExecutablePath,
    [ValidateSet('State', 'Minimize', 'Restore', 'Move', 'Resize', 'TopEdge')][string]$Action = 'State',
    [int]$ClientWidth,
    [int]$ClientHeight,
    [string]$CapturePath
)
$ErrorActionPreference = 'Stop'
$launcher = Get-Process -Id $LauncherProcessId
if ($launcher.Path -ne [IO.Path]::GetFullPath($ExecutablePath)) {
    throw 'The process is not the isolated launcher test executable.'
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MotionWindow {
    public delegate bool Callback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetStyle(IntPtr handle, int index);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle, ref Point point);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle, IntPtr device, uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    public static IntPtr Find(int processId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((handle, parameter) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            var title = new StringBuilder(256);
            GetWindowText(handle, title, 256);
            if (owner == processId && title.ToString().StartsWith("SFMCL-T")) {
                result = handle;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
    public static IntPtr Shadow(int processId, IntPtr owner) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((handle, parameter) => {
            uint process;
            GetWindowThreadProcessId(handle, out process);
            var name = new StringBuilder(128);
            GetClassName(handle, name, 128);
            if (process == processId && GetWindow(handle, 4) == owner && name.ToString() == "Static" && (GetStyle(handle, -20) & 0x80000) != 0) {
                result = handle;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
$handle = [MotionWindow]::Find($LauncherProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'Isolated launcher window not found.' }
if ($Action -eq 'Minimize') { [void][MotionWindow]::ShowWindow($handle, 6) }
if ($Action -eq 'Restore') { [void][MotionWindow]::ShowWindow($handle, 9) }
$outer = New-Object MotionWindow+Rect
$client = New-Object MotionWindow+Rect
[void][MotionWindow]::GetWindowRect($handle, [ref]$outer)
[void][MotionWindow]::GetClientRect($handle, [ref]$client)
if ($Action -eq 'Move') {
    [void][MotionWindow]::SetWindowPos($handle, [IntPtr]::Zero, ($outer.Left + 36), ($outer.Top + 24), 0, 0, 0x15)
}
if ($Action -eq 'Resize') {
    if ($ClientWidth -le 0 -or $ClientHeight -le 0) { throw 'Expected a positive client size.' }
    $width = $ClientWidth + $outer.Right - $outer.Left - $client.Right
    $height = $ClientHeight + $outer.Bottom - $outer.Top - $client.Bottom
    [void][MotionWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $width, $height, 0x16)
    [void][MotionWindow]::GetWindowRect($handle, [ref]$outer)
}
[void][MotionWindow]::GetClientRect($handle, [ref]$client)
$origin = New-Object MotionWindow+Point
[void][MotionWindow]::ClientToScreen($handle, [ref]$origin)
$leftColor = $null
$rightColor = $null
if ($Action -eq 'TopEdge') {
    Add-Type -AssemblyName System.Drawing
    $bitmap = $null
    $graphics = $null
    try {
        $bitmap = New-Object System.Drawing.Bitmap(($outer.Right - $outer.Left), ([Math]::Min(200, $outer.Bottom - $outer.Top)))
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $device = $graphics.GetHdc()
        try {
            if (-not [MotionWindow]::PrintWindow($handle, $device, 2)) { throw 'Cannot render isolated window pixels.' }
        } finally { $graphics.ReleaseHdc($device) }
        $left = $bitmap.GetPixel(($origin.X - $outer.Left + [int]($client.Right / 16)), 0)
        $right = $bitmap.GetPixel(($origin.X - $outer.Left + [int]($client.Right * 3 / 4)), 0)
        $leftColor = '{0},{1},{2}' -f $left.R, $left.G, $left.B
        $rightColor = '{0},{1},{2}' -f $right.R, $right.G, $right.B
        if ($CapturePath) { $bitmap.Save($CapturePath, [System.Drawing.Imaging.ImageFormat]::Png) }
    } finally {
        if ($graphics) { $graphics.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
    }
}
$rendering = 0
[void][MotionWindow]::DwmGetWindowAttribute($handle, 1, [ref]$rendering, 4)
$corners = 0
[void][MotionWindow]::DwmGetWindowAttribute($handle, 33, [ref]$corners, 4)
$shadow = [MotionWindow]::Shadow($LauncherProcessId, $handle)
$shadowBounds = New-Object MotionWindow+Rect
$shadowVisible = $false
$shadowPassThrough = $false
if ($shadow -ne [IntPtr]::Zero) {
    [void][MotionWindow]::GetWindowRect($shadow, [ref]$shadowBounds)
    $shadowVisible = [MotionWindow]::IsWindowVisible($shadow)
    $shadowPassThrough = ([MotionWindow]::GetStyle($shadow, -20) -band 0x080000A0) -eq 0x080000A0
}
@{
    rendering = $rendering
    corners = $corners
    width = $outer.Right - $outer.Left
    height = $outer.Bottom - $outer.Top
    clientWidth = $client.Right
    clientHeight = $client.Bottom
    topInset = $origin.Y - $outer.Top
    leftColor = $leftColor
    rightColor = $rightColor
    clientLeft = $origin.X
    clientTop = $origin.Y
    shadowVisible = $shadowVisible
    shadowPassThrough = $shadowPassThrough
    shadowLeft = $shadowBounds.Left
    shadowTop = $shadowBounds.Top
    shadowRight = $shadowBounds.Right
    shadowBottom = $shadowBounds.Bottom
} | ConvertTo-Json -Compress
