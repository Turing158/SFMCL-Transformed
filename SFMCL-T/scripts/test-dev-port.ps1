#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')

$occupied = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 0)
$available = $null
try {
    $occupied.Server.ExclusiveAddressUse = $true
    $occupied.Start()
    $preferred = $occupied.LocalEndpoint.Port
    $selected = Get-AvailableDevelopmentPort -PreferredPort $preferred
    if ($selected -le $preferred -or $selected -gt [Math]::Min(65535, $preferred + 99)) {
        throw "An occupied port was not replaced: $preferred -> $selected"
    }
    # The original listener must remain intact; the selected port must be free
    # for Vite immediately after the probe is disposed.
    $connection = [Net.Sockets.TcpClient]::new()
    try { $connection.Connect([Net.IPAddress]::Loopback, $preferred) }
    finally { $connection.Dispose() }
    $available = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $selected)
    $available.Server.ExclusiveAddressUse = $true
    $available.Start()
    $available.Stop()
    $available = $null
    if ((Get-AvailableDevelopmentPort -PreferredPort $selected) -ne $selected) {
        throw 'A free preferred port should be preserved.'
    }
    Write-Host 'PASS occupied/wildcard listener preserved, available port selected, probe released, free preferred port retained.'
} finally {
    if ($available) { $available.Stop() }
    $occupied.Stop()
}
