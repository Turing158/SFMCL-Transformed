# Pinned, verified build tools. Nothing is installed system-wide or shipped with the app.
Set-StrictMode -Version Latest

function Get-VerifiedPackagingDownload {
    param([string]$Path, [string]$Url, [string]$Sha256)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
        $partial = "$Path.$([guid]::NewGuid().ToString('N')).part"
        try {
            Write-Host "Downloading packaging tool: $Url"
            Invoke-Checked -File 'curl.exe' -Arguments @('--fail', '--silent', '--show-error', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '300', '--proto', '=https', '--proto-redir', '=https', '--output', $partial, $Url)
            if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
                throw "Packaging tool checksum mismatch: $Url"
            }
            Move-Item -LiteralPath $partial -Destination $Path -Force
        } finally {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        }
    }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Sha256) {
        throw "Invalid cached packaging tool: $Path. Remove this file and retry."
    }
    return $Path
}

function Get-PackagingCompressor {
    param([ValidateSet('upx', '7zip')][string]$Name, [string]$CacheRoot)
    [void][IO.Directory]::CreateDirectory($CacheRoot)
    if ($Name -eq 'upx') {
        $executable = Join-Path $CacheRoot 'upx-5.2.1-win64\upx.exe'
        $expected = 'D20EBE0B7B22B6BE968C8C34BE61F94DDEA12CB11462E2CEC27F548EF9574DF8'
        if (-not (Test-Path -LiteralPath $executable)) {
            $archive = Get-VerifiedPackagingDownload -Path (Join-Path $CacheRoot 'upx-5.2.1-win64.zip') `
                -Url 'https://github.com/upx/upx/releases/download/v5.2.1/upx-5.2.1-win64.zip' `
                -Sha256 'EABC6792A347D45E945BE7748423E7868FD01B0D2BCAA2F4B1031FD71FF69BDA'
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($archive, $CacheRoot)
        }
    } else {
        $directory = Join-Path $CacheRoot '7zip-26.04'
        $executable = Join-Path $directory 'x64\7za.exe'
        $expected = '15D4C788C148E3677E2FC1C4A01F191FB6669EBA4F6ACF8A465F0F1A6F1E1260'
        if (-not (Test-Path -LiteralPath $executable)) {
            $extractor = Get-VerifiedPackagingDownload -Path (Join-Path $CacheRoot '7zr-26.04.exe') `
                -Url 'https://github.com/ip7z/7zip/releases/download/26.04/7zr.exe' `
                -Sha256 '256FECA8E274E5DA655E2A284FABAFD9F554365EB164862089DACD4E8276D282'
            $archive = Get-VerifiedPackagingDownload -Path (Join-Path $CacheRoot '7z2604-extra.7z') `
                -Url 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-extra.7z' `
                -Sha256 'DC4B11D3399DB18B063630137145F5585D8F7AC847BF3639BD1185D7D1F7CEE0'
            Invoke-Checked -File $extractor -Arguments @('x', '-y', '-bsp0', "-o$directory", $archive)
        }
    }
    if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $expected) {
        throw "Invalid packaging executable: $executable. Remove its cache directory and retry."
    }
    return $executable
}

function Compress-SingleExecutable {
    param([string]$Source, [string]$Destination, [string]$CacheRoot)
    if (Test-Path -LiteralPath $Destination) { throw "Compression output already exists: $Destination" }
    $upx = Get-PackagingCompressor -Name upx -CacheRoot $CacheRoot
    Write-Host 'Compressing the single executable with UPX...'
    # Keep relocations and overlays; the executable remains usable with ASLR.
    Invoke-Checked -File $upx -Arguments @('--ultra-brute', '--strip-relocs=0', '--no-progress', '-o', $Destination, $Source)
    Invoke-Checked -File $upx -Arguments @('-t', $Destination)
    if ((Get-Item -LiteralPath $Destination).Length -ge (Get-Item -LiteralPath $Source).Length) {
        throw 'Executable compression did not reduce the file size.'
    }
}

function Compress-PortableDirectory {
    param([string]$Directory, [string]$Destination, [ValidateSet('7z', 'zip')][string]$Format, [string]$CacheRoot)
    if (Test-Path -LiteralPath $Destination) { throw "Archive output already exists: $Destination" }
    $sevenZip = Get-PackagingCompressor -Name 7zip -CacheRoot $CacheRoot
    $arguments = @('a', "-t$Format", '-mx=9', '-bsp0', '-y')
    if ($Format -eq '7z') {
        # A solid archive shares its dictionary across the complete, unmodified runtime.
        $arguments += @('-m0=LZMA2', '-md=128m', '-mfb=273', '-ms=on', '-mmt=2')
    } else {
        # Standard Deflate remains compatible with Windows Explorer ZIP extraction.
        $arguments += @('-mm=Deflate', '-mfb=258', '-mpass=15', '-mmt=2')
    }
    Push-Location -LiteralPath (Split-Path -Parent $Directory)
    try {
        Invoke-Checked -File $sevenZip -Arguments ($arguments + @($Destination, (Split-Path -Leaf $Directory)))
        Invoke-Checked -File $sevenZip -Arguments @('t', '-bsp0', $Destination)
    } finally { Pop-Location }
}
