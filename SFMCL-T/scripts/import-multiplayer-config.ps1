#requires -Version 5.1
<#
.SYNOPSIS
Import a private multiplayer API and node configuration into the current user's DPAPI store.
.DESCRIPTION
The source JSON contains api_url and optional shared_node_urls. Only its path is
accepted; configuration values never pass through command-line arguments or stdout.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceFile
)

$ErrorActionPreference = 'Stop'
$plaintext = $null
$roundTrip = $null
$temporary = $null
try {
    Add-Type -AssemblyName System.Security
    $configuration = [IO.File]::ReadAllText($SourceFile) | ConvertFrom-Json
    $api = $null
    if (-not [Uri]::TryCreate([string]$configuration.api_url, [UriKind]::Absolute, [ref]$api) -or
        $api.Scheme -ne 'https' -or -not $api.Host -or $api.UserInfo -or
        $api.AbsolutePath -ne '/' -or $api.Query -or $api.Fragment) {
        throw 'Invalid API root.'
    }
    $nodes = @($configuration.shared_node_urls | Where-Object { $_ })
    if ($nodes.Count -gt 5) { throw 'Too many shared nodes.' }
    foreach ($node in $nodes) {
        $address = $null
        if ($node -isnot [string] -or $node.Length -gt 512 -or
            -not [Uri]::TryCreate($node, [UriKind]::Absolute, [ref]$address) -or
            $address.Scheme -notin @('tcp', 'udp', 'ws', 'wss', 'quic') -or
            -not $address.Host -or $address.UserInfo -or
            ($address.Port -le 0 -and $address.Scheme -notin @('ws', 'wss'))) {
            throw 'Invalid shared node.'
        }
    }
    $configuration = @{
        api_url = $api.AbsoluteUri.TrimEnd('/')
        shared_node_urls = $nodes
    }
    $plaintext = [Text.Encoding]::UTF8.GetBytes(($configuration | ConvertTo-Json -Depth 4 -Compress))
    $encrypted = [Security.Cryptography.ProtectedData]::Protect(
        $plaintext, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    if ([Convert]::ToBase64String($plaintext) -cne [Convert]::ToBase64String($roundTrip)) {
        throw 'Configuration protection verification failed.'
    }

    $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SFMCL-T\service-credentials'
    [void][IO.Directory]::CreateDirectory($directory)
    $destination = Join-Path $directory 'playtogether.dat'
    $temporary = Join-Path $directory ('playtogether.dat.' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllBytes($temporary, $encrypted)
    Move-Item -LiteralPath $temporary -Destination $destination -Force
    $temporary = $null
    Write-Output 'Private multiplayer configuration saved to the current Windows user encrypted store.'
} catch {
    [Console]::Error.WriteLine('Multiplayer configuration import failed. Addresses and source details were suppressed.')
    exit 1
} finally {
    if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
    if ($null -ne $roundTrip) { [Array]::Clear($roundTrip, 0, $roundTrip.Length) }
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
    $configuration = $null
}
