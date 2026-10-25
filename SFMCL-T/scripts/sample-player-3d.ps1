param([int]$RootProcessId, [int]$Seconds = 10)
$ErrorActionPreference = 'Stop'
$logicalProcessors = [Environment]::ProcessorCount
$samples = @()
$previousCpu = $null
$previousTime = $null
for ($index = 0; $index -le $Seconds; $index++) {
    $allProcesses = Get-CimInstance Win32_Process
    $processIds = [Collections.Generic.HashSet[int]]::new()
    [void]$processIds.Add($RootProcessId)
    do {
        $count = $processIds.Count
        foreach ($item in $allProcesses) {
            if ($processIds.Contains([int]$item.ParentProcessId)) { [void]$processIds.Add([int]$item.ProcessId) }
        }
    } while ($count -ne $processIds.Count)
    $processes = @(Get-Process -Id @($processIds) -ErrorAction SilentlyContinue)
    $time = [DateTime]::UtcNow
    $cpu = ($processes | Measure-Object -Property CPU -Sum).Sum
    $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^pid_(\d+)_' -and $processIds.Contains([int]$Matches[1])
    })
    if ($null -ne $previousCpu) {
        $samples += [pscustomobject]@{
            time = $time.ToString('o')
            cpuPercentOfMachine = [Math]::Max(0.0, [double](($cpu - $previousCpu) / ($time - $previousTime).TotalSeconds / $logicalProcessors * 100))
            workingSetBytes = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum
            privateBytes = ($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
            busiestGpuEnginePercent = ($engines | Measure-Object -Property UtilizationPercentage -Maximum).Maximum
            processCount = $processes.Count
        }
    }
    $previousCpu = $cpu
    $previousTime = $time
    if ($index -lt $Seconds) { Start-Sleep -Milliseconds 1000 }
}
[pscustomobject]@{ logicalProcessors = $logicalProcessors; samples = $samples } | ConvertTo-Json -Depth 5 -Compress
