# Fixed Version Runtime downloads come from Microsoft's official download page.
Set-StrictMode -Version Latest

function Get-WebView2Download {
    param([string]$Version)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $page = Invoke-WebRequest -UseBasicParsing -Uri 'https://developer.microsoft.com/en-us/microsoft-edge/webview2' -TimeoutSec 60
    $html = $page.Content.Replace('\u002F', '/').Replace('\u002f', '/').Replace('\/', '/')
    $pattern = 'https://msedge\.sf\.dl\.delivery\.mp\.microsoft\.com/filestreamingservice/files/[0-9a-f-]+/Microsoft\.WebView2\.FixedVersionRuntime\.(?<version>\d+\.\d+\.\d+\.\d+)\.x64\.cab'
    $downloads = @([regex]::Matches($html, $pattern) | ForEach-Object {
        [pscustomobject]@{ Version = $_.Groups['version'].Value; Url = $_.Value }
    } | Sort-Object { [version]$_.Version } -Descending -Unique)
    if ($Version) { $downloads = @($downloads | Where-Object Version -EQ $Version) }
    if ($downloads.Count -eq 0) {
        throw 'No matching x64 Fixed Version Runtime was found on the Microsoft page. Supply -WebView2Path with an extracted official Fixed Version Runtime.'
    }
    return $downloads[0]
}

function Assert-FixedWebView2 {
    param([string]$Directory)
    foreach ($relative in @('msedgewebview2.exe', 'msedge.dll', 'icudtl.dat', 'locales')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $relative))) {
            throw "Incomplete Fixed Version Runtime: missing $relative in $Directory"
        }
    }
    $executable = Join-Path $Directory 'msedgewebview2.exe'
    $runtimeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable).FileVersion
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($executable))
    try {
        $reader.BaseStream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        $reader.BaseStream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
            throw 'The Fixed Version Runtime must contain a Windows x64 executable.'
        }
    } finally { $reader.Dispose() }
    foreach ($file in @('msedgewebview2.exe', 'msedge.dll')) {
        $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $Directory $file)
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
            throw "Invalid Microsoft signature on $file in $Directory"
        }
        if ([Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Directory $file)).FileVersion -ne $runtimeVersion) {
            throw "The Fixed Version Runtime contains mixed engine versions: $Directory"
        }
    }
    return $runtimeVersion
}

function Get-FixedWebView2 {
    param([string]$CacheRoot, [string]$Directory, [string]$Version)
    if ($Directory) {
        $resolved = (Resolve-Path -LiteralPath $Directory).Path
        $runtimeVersion = Assert-FixedWebView2 -Directory $resolved
        if ($Version -and $runtimeVersion -ne $Version) { throw "Expected WebView2 $Version, found $runtimeVersion." }
        return [pscustomobject]@{ Path = $resolved; Version = $runtimeVersion; Source = 'local Fixed Version Runtime' }
    }

    # Reuse a complete, validated download without requiring an Internet connection.
    $cached = @(Get-ChildItem -LiteralPath $CacheRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'complete.json')) } |
        Sort-Object { [version]$_.Name } -Descending)
    if ($Version) { $cached = @($cached | Where-Object Name -EQ $Version) }
    if ($cached.Count -gt 0) {
        $manifest = Get-Content -LiteralPath (Join-Path $cached[0].FullName 'complete.json') -Raw | ConvertFrom-Json
        $runtime = Join-Path $cached[0].FullName 'WebView2'
        $runtimeVersion = Assert-FixedWebView2 -Directory $runtime
        if ($runtimeVersion -ne $cached[0].Name -or $runtimeVersion -ne $manifest.version) {
            throw "The WebView2 cache version is inconsistent: $($cached[0].FullName)"
        }
        return [pscustomobject]@{ Path = $runtime; Version = $runtimeVersion; Source = $manifest.source }
    }

    $download = Get-WebView2Download -Version $Version
    $versionRoot = Join-Path $CacheRoot $download.Version
    [void][IO.Directory]::CreateDirectory($versionRoot)
    $cab = Join-Path $versionRoot 'runtime.cab'
    if (-not (Test-Path -LiteralPath $cab)) {
        $partial = "$cab.part"
        Write-Host "Downloading Microsoft WebView2 $($download.Version) x64..."
        Invoke-Checked -File 'curl.exe' -Arguments @('--fail', '--silent', '--show-error', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '1800', '--proto', '=https', '--proto-redir', '=https', '--output', $partial, $download.Url)
        Move-Item -LiteralPath $partial -Destination $cab -Force
    }
    # Extract into a fresh directory; a failed extraction is never accepted as a cache hit.
    $extract = Join-Path $versionRoot ('extract-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($extract)
    Write-Host 'Extracting the Fixed Version Runtime...'
    & "$env:SystemRoot\System32\expand.exe" $cab '-F:*' $extract | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot extract $cab. Remove this cached CAB and retry." }
    $engines = @(Get-ChildItem -LiteralPath $extract -Filter msedgewebview2.exe -Recurse -File)
    if ($engines.Count -ne 1) { throw "Expected one WebView2 engine in $cab." }
    $runtimeVersion = Assert-FixedWebView2 -Directory $engines[0].DirectoryName
    if ($runtimeVersion -ne $download.Version) { throw 'Downloaded WebView2 version does not match its file name.' }
    $runtime = Join-Path $versionRoot 'WebView2'
    if (Test-Path -LiteralPath $runtime) { throw "Incomplete cache at $versionRoot. Remove it and retry, or use -WebView2Path." }
    # Both source and destination are explicit children of the generated cache directory.
    $cacheBoundary = [IO.Path]::GetFullPath($versionRoot).TrimEnd('\') + '\'
    foreach ($path in @($engines[0].DirectoryName, $runtime)) {
        if (-not [IO.Path]::GetFullPath($path).StartsWith($cacheBoundary, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Runtime cache path escaped its directory.'
        }
    }
    Move-Item -LiteralPath $engines[0].DirectoryName -Destination $runtime
    Remove-PackagingScratch -Path $extract -Root $versionRoot
    $manifest = [ordered]@{ version = $runtimeVersion; source = $download.Url; cabSha256 = (Get-FileHash -LiteralPath $cab -Algorithm SHA256).Hash }
    [IO.File]::WriteAllText((Join-Path $versionRoot 'complete.json'), ($manifest | ConvertTo-Json))
    return [pscustomobject]@{ Path = $runtime; Version = $runtimeVersion; Source = $download.Url }
}
