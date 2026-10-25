#requires -Version 5.1
# Runs in NSIS's private temporary directory. No runtime is embedded in the installer.
[CmdletBinding()]
param([switch]$DownloadOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    foreach ($moduleName in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security')) {
        Import-Module (Join-Path $PSHOME "Modules\$moduleName\$moduleName.psd1") -ErrorAction Stop
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $bootstrapper = Join-Path $PSScriptRoot 'MicrosoftEdgeWebview2Setup.exe'
    $download = "$bootstrapper.part"
    Write-Output 'Downloading WebView2 from Microsoft...'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $download -TimeoutSec 300
    $signature = Get-AuthenticodeSignature -LiteralPath $download
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
        throw 'The WebView2 installer does not have a valid Microsoft signature.'
    }
    Move-Item -LiteralPath $download -Destination $bootstrapper -Force
    if ($DownloadOnly) {
        Write-Output 'Microsoft signature verified; download complete.'
        exit 0
    }
    Write-Output 'Installing WebView2 Runtime...'
    $installer = Start-Process -FilePath $bootstrapper -ArgumentList @('/silent', '/install') -WindowStyle Hidden -Wait -PassThru
    if ($installer.ExitCode -notin @(0, 3010, 1641)) {
        throw "WebView2 installer failed (exit code $($installer.ExitCode))."
    }
    exit $installer.ExitCode
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
