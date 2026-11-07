#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$targetRoot = Join-Path $repositoryRoot 'SFMCL-T\target'
$temporaryRoot = Join-Path $targetRoot 'tmp'
foreach ($directory in @($repositoryRoot, (Split-Path -Parent $targetRoot), $targetRoot)) {
    if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Linked test parent: $directory"
    }
}
[void][IO.Directory]::CreateDirectory($temporaryRoot)
if ((Get-Item -LiteralPath $temporaryRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Linked temporary root'
}
$fixtureRoot = Join-Path $temporaryRoot ('cleanup-verification-' + [guid]::NewGuid().ToString('N'))
$fixtureTarget = Join-Path $fixtureRoot 'SFMCL-T\target'
$fixtureScript = Join-Path $fixtureRoot 'clean-target.ps1'
$junctionPath = $null

function Write-Fixture {
    param([string]$RelativePath, [string]$Content = 'fixture', [int]$AgeDays = 0)
    $path = Join-Path $fixtureTarget $RelativePath
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
    [IO.File]::WriteAllText($path, $Content)
    if ($AgeDays) { (Get-Item -LiteralPath $path).LastWriteTime = (Get-Date).AddDays(-$AgeDays) }
}
function Assert-Fixture {
    param([string]$RelativePath, [bool]$Expected)
    $exists = Test-Path -LiteralPath (Join-Path $fixtureTarget $RelativePath)
    if ($exists -ne $Expected) { throw "Unexpected existence ($exists): $RelativePath" }
}
function Invoke-FixtureCleanup {
    param([string[]]$CleanupArguments = @(), [bool]$ExpectFailure = $false)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = 'powershell.exe'
    $start.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $fixtureScript + '" ' + ($CleanupArguments -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($start)
    try {
        $output = $child.StandardOutput.ReadToEnd()
        $errors = $child.StandardError.ReadToEnd()
        $child.WaitForExit()
        if (($child.ExitCode -ne 0) -ne $ExpectFailure) {
            throw "Unexpected cleanup exit $($child.ExitCode): $output $errors"
        }
    } finally { $child.Dispose() }
}
try {
    [void][IO.Directory]::CreateDirectory($fixtureTarget)
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'clean-target.ps1') -Destination $fixtureScript
    $protected = @(
        'debug\deps\libdependency.rlib', 'debug\deps\dependency.pdb',
        'debug\build\dependency\out\keep.lib', 'debug\sfmcl-t.exe',
        'debug\sfmcl_t.pdb', 'debug\sfmcl_t_app.lib',
        'debug\.fingerprint\dependency-aaaaaaaaaaaaaaaa\lib-dependency.json',
        'x86_64-pc-windows-msvc\release\bundle\nsis\setup.exe',
        'x86_64-pc-windows-msvc\release\resources\keep.json'
    )
    $protectedHashes = @{}
    foreach ($path in $protected) {
        Write-Fixture -RelativePath $path
        $protectedHashes[$path] = (Get-FileHash -LiteralPath (Join-Path $fixtureTarget $path)).Hash
    }
    Write-Fixture 'debug\expired.tmp' 'old' 2
    Write-Fixture 'debug\recent.temp'
    Write-Fixture 'tmp\expired.log' 'old' 2
    Write-Fixture 'tmp\recent\fresh.json'
    (Get-Item -LiteralPath (Join-Path $fixtureTarget 'tmp\recent')).LastWriteTime = (Get-Date).AddDays(-2)
    Write-Fixture 'debug\incremental\core\session\object.o'
    Write-Fixture 'debug\.fingerprint\sfmcl-t-core-bbbbbbbbbbbbbbbb\test-lib-sfmcl_t_core.json' '{}'
    foreach ($extension in @('.exe', '.pdb', '.d')) {
        Write-Fixture ('debug\deps\sfmcl_t_core-bbbbbbbbbbbbbbbb' + $extension)
        Write-Fixture ('debug\examples\smoke_install' + $extension)
    }
    Write-Fixture 'debug\examples\libsmoke_install-cccccccccccccccc.rmeta'
    Write-Fixture 'debug\.fingerprint\sfmcl-t-core-cccccccccccccccc\example-smoke_install.json' '{}'

    Invoke-FixtureCleanup -CleanupArguments @('-WhatIf')
    Assert-Fixture 'debug\expired.tmp' $true
    Assert-Fixture 'tmp\expired.log' $true
    Invoke-FixtureCleanup
    Assert-Fixture 'debug\expired.tmp' $false
    Assert-Fixture 'tmp\expired.log' $false
    Assert-Fixture 'debug\recent.temp' $true
    Assert-Fixture 'tmp\recent\fresh.json' $true
    Assert-Fixture 'debug\incremental\core\session\object.o' $true
    Write-Host 'PASS: default cleanup and 24-hour retention.'

    Invoke-FixtureCleanup -CleanupArguments @('-PruneBuildCache', '-WhatIf')
    Assert-Fixture 'debug\incremental\core\session\object.o' $true
    Assert-Fixture 'debug\deps\sfmcl_t_core-bbbbbbbbbbbbbbbb.exe' $true
    Invoke-FixtureCleanup -CleanupArguments @('-PruneBuildCache')
    Assert-Fixture 'debug\incremental' $true
    Assert-Fixture 'debug\incremental\core' $false
    Assert-Fixture 'debug\deps\sfmcl_t_core-bbbbbbbbbbbbbbbb.exe' $false
    Assert-Fixture 'debug\deps\sfmcl_t_core-bbbbbbbbbbbbbbbb.pdb' $false
    Assert-Fixture 'debug\.fingerprint\sfmcl-t-core-bbbbbbbbbbbbbbbb' $false
    Assert-Fixture 'debug\.fingerprint\sfmcl-t-core-cccccccccccccccc' $false
    Assert-Fixture 'debug\examples\smoke_install.exe' $false
    Assert-Fixture 'debug\examples\libsmoke_install-cccccccccccccccc.rmeta' $false
    foreach ($path in $protected) {
        Assert-Fixture $path $true
        if ((Get-FileHash -LiteralPath (Join-Path $fixtureTarget $path)).Hash -ne $protectedHashes[$path]) {
            throw "Protected output changed: $path"
        }
    }
    Write-Host 'PASS: pruning, dry run, fingerprint matching and protected-output hashes.'

    Write-Fixture 'debug\incremental\blocked\object.o'
    Write-Fixture 'debug\blocked.tmp' 'old' 2
    $lock = [IO.File]::Open((Join-Path $fixtureTarget 'debug\.cargo-lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Invoke-FixtureCleanup -CleanupArguments @('-PruneBuildCache') -ExpectFailure $true }
    finally { $lock.Dispose() }
    Assert-Fixture 'debug\incremental\blocked\object.o' $true
    Assert-Fixture 'debug\blocked.tmp' $true
    Write-Host 'PASS: occupied Cargo lock prevents all deletion.'

    $externalRoot = Join-Path $fixtureRoot 'outside-target'
    [void][IO.Directory]::CreateDirectory($externalRoot)
    $sentinel = Join-Path $externalRoot 'keep.txt'
    [IO.File]::WriteAllText($sentinel, 'outside target')
    $junctionPath = Join-Path $fixtureTarget 'debug\incremental\junction'
    New-Item -ItemType Junction -Path $junctionPath -Target $externalRoot | Out-Null
    Invoke-FixtureCleanup -CleanupArguments @('-PruneBuildCache') -ExpectFailure $true
    Assert-Fixture 'debug\blocked.tmp' $true
    if ([IO.File]::ReadAllText($sentinel) -ne 'outside target') { throw 'External junction target changed' }
    [IO.Directory]::Delete($junctionPath)
    $junctionPath = $null
    Write-Host 'PASS: junction rejected before deletion; external target untouched.'
} finally {
    if ($junctionPath -and (Test-Path -LiteralPath $junctionPath)) {
        if (-not ((Get-Item -LiteralPath $junctionPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Expected a junction for test teardown'
        }
        [IO.Directory]::Delete($junctionPath)
    }
    if (Test-Path -LiteralPath $fixtureRoot) {
        $resolved = (Resolve-Path -LiteralPath $fixtureRoot).ProviderPath
        if (-not $resolved.StartsWith($temporaryRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe fixture teardown: $resolved"
        }
        $pending = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
        $pending.Push((Get-Item -LiteralPath $resolved))
        while ($pending.Count -gt 0) {
            foreach ($entry in $pending.Pop().GetFileSystemInfos()) {
                if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked fixture teardown refused' }
                if ($entry -is [IO.DirectoryInfo]) { $pending.Push($entry) }
            }
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
Write-Host 'All target cleanup checks passed; fixture removed.'
