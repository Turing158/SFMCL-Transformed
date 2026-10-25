#requires -Version 5.1
<#
.SYNOPSIS
Import the local StarFallMCL CurseForge credential into the current user's DPAPI store.
.DESCRIPTION
Only a source directory is accepted. The credential never passes through command-line
arguments, stdout, the repository, frontend configuration, or build output.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StarFallRoot
)

$ErrorActionPreference = 'Stop'
$plaintext = $null
$roundTrip = $null
$temporary = $null
try {
    Add-Type -AssemblyName System.Security
    $sourcePath = Join-Path $StarFallRoot 'StarFallMC\Util\KeyUtil.cs'
    $sourceText = [IO.File]::ReadAllText($sourcePath)
    $declaration = [regex]::Match($sourceText, '\bCURSEFORGE_API_KEY\s*=\s*"([^"\r\n]+)"\s*;')
    if (-not $declaration.Success) { throw 'Missing credential declaration.' }
    $credential = $declaration.Groups[1].Value.Trim()
    if (-not $credential -or $credential.Contains('\')) { throw 'Unsupported credential declaration.' }

    # Verify with the intended service only. Never follow a redirect with the key.
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 `
        -Uri 'https://api.curseforge.com/v1/categories?gameId=432' `
        -Headers @{ 'x-api-key' = $credential; 'User-Agent' = 'SFMCL-T/0.1.0' }
    if ($response.StatusCode -ne 200 -or @((ConvertFrom-Json $response.Content).data).Count -eq 0) {
        throw 'Credential validation failed.'
    }

    $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SFMCL-T\service-credentials'
    [void][IO.Directory]::CreateDirectory($directory)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $directory -AclObject $acl

    $plaintext = [Text.Encoding]::UTF8.GetBytes($credential)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect(
        $plaintext, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    if ([Convert]::ToBase64String($plaintext) -cne [Convert]::ToBase64String($roundTrip)) {
        throw 'Credential protection verification failed.'
    }
    $destination = Join-Path $directory 'curseforge.dat'
    $temporary = Join-Path $directory ('curseforge.dat.' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllBytes($temporary, $encrypted)
    Move-Item -LiteralPath $temporary -Destination $destination -Force
    $temporary = $null
    Write-Output 'CurseForge credential verified and saved to the current Windows user encrypted store.'
} catch {
    # Do not print exception details: HTTP errors can contain request/response data.
    [Console]::Error.WriteLine('CurseForge credential import failed. Source, credential and response details were suppressed.')
    exit 1
} finally {
    if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
    if ($null -ne $roundTrip) { [Array]::Clear($roundTrip, 0, $roundTrip.Length) }
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
    $credential = $null
    $sourceText = $null
    $declaration = $null
}
