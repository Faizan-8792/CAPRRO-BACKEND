# Runs the backend release gates and writes one plain-text summary.
# By default this includes commit-pinned deployment archive validation, which requires a clean
# tracked worktree. Use -SkipDeployArchiveValidation only for pre-commit development checks.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-gates.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-gates.ps1 -SkipDeployArchiveValidation

[CmdletBinding()]
param(
    [string]$RepoRoot = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend",
    [string]$LogPath = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend\gates.log",
    [string]$ArchiveOutputDirectory = "D:\CA-PRO-Toolkit",
    [switch]$SkipDeployArchiveValidation
)

$ErrorActionPreference = "Stop"
$report = New-Object System.Collections.Generic.List[string]
$failures = 0
$archiveValidationSkipped = [bool]$SkipDeployArchiveValidation
$processTimeoutMs = 300000
$digestTimeoutMs = 600000
$archiveTimeoutMs = 600000
# Measured 336,956ms for the boundary suite on this machine with roughly twenty
# background node processes competing, and 648,000-896,000ms earlier in the same
# session under heavier contention. 1,800,000ms was set to clear that worst case
# but is loose enough to hide a real slowdown, while the 600,000ms a review
# suggested would have failed those loaded runs and produced a flaky gate. 900,000
# sits above the worst observed run and still halves the bound, so a regression
# that doubles the suite's cost is caught.
$boundaryTimeoutMs = 900000

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Argument)

    if ($Argument.Length -eq 0) { return '""' }
    if ($Argument -notmatch '[\s"]') { return $Argument }
    return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Resolve-ApplicationPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    $commands = @(Get-Command $Name -CommandType Application -All -ErrorAction Stop)
    if ($commands.Count -eq 0) { throw "required executable is unavailable: $Name" }
    return [System.IO.Path]::GetFullPath($commands[0].Source)
}

function New-KillOnCloseProcessJob {
    if ($null -eq ("Capro.Processes.KillOnCloseJob" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Capro.Processes
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public sealed class KillOnCloseJob : IDisposable
    {
        private const int JobObjectExtendedLimitInformationClass = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private IntPtr handle;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            ref JobObjectExtendedLimitInformation information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public KillOnCloseJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create process job object.");
            }

            JobObjectExtendedLimitInformation information = new JobObjectExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            uint informationLength = (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            if (!SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformationClass,
                ref information,
                informationLength
            ))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(handle);
                handle = IntPtr.Zero;
                throw new Win32Exception(error, "Unable to configure process job object.");
            }
        }

        public void Assign(IntPtr processHandle)
        {
            if (handle == IntPtr.Zero)
            {
                throw new ObjectDisposedException("KillOnCloseJob");
            }
            if (processHandle == IntPtr.Zero)
            {
                throw new ArgumentException("Process handle is invalid.", "processHandle");
            }
            if (!AssignProcessToJobObject(handle, processHandle))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Unable to assign process to kill-on-close job object."
                );
            }
        }

        public void Dispose()
        {
            if (handle == IntPtr.Zero)
            {
                return;
            }
            IntPtr value = handle;
            handle = IntPtr.Zero;
            CloseHandle(value);
            GC.SuppressFinalize(this);
        }

        ~KillOnCloseJob()
        {
            Dispose();
        }
    }
}
'@
    }

    $jobType = "Capro.Processes.KillOnCloseJob" -as [type]
    if ($null -eq $jobType) { throw "kill-on-close process job type is unavailable" }
    return [Activator]::CreateInstance($jobType)
}

function Get-ContainedProcessLauncherCommand {
    return @'
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$configName = "CAPRO_CONTAINED_PROCESS_CONFIG"
$configPayload = [Environment]::GetEnvironmentVariable($configName, "Process")
if ([string]::IsNullOrWhiteSpace($configPayload)) {
    throw "contained process configuration is unavailable"
}
try {
    $configJson = [System.Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($configPayload)
    )
    $config = $configJson | ConvertFrom-Json
}
finally {
    [Environment]::SetEnvironmentVariable($configName, $null, "Process")
}
if (
    $null -eq $config -or
    $config.filePath -isnot [string] -or
    [string]::IsNullOrWhiteSpace($config.filePath) -or
    $config.arguments -isnot [string] -or
    $config.workingDirectory -isnot [string] -or
    [string]::IsNullOrWhiteSpace($config.workingDirectory)
) {
    throw "contained process configuration is invalid"
}

$inputStream = [Console]::OpenStandardInput()
$handshake = $inputStream.ReadByte()
if ($handshake -ne 67) {
    throw "contained process launch was not authorized"
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $config.filePath
$startInfo.Arguments = $config.arguments
$startInfo.WorkingDirectory = $config.workingDirectory
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$child = [System.Diagnostics.Process]::new()
$child.StartInfo = $startInfo
$started = $false
try {
    $started = $child.Start()
    if (-not $started) { throw "unable to start contained process" }

    $outputStream = [Console]::OpenStandardOutput()
    $errorStream = [Console]::OpenStandardError()
    $outputTask = $child.StandardOutput.BaseStream.CopyToAsync($outputStream)
    $errorTask = $child.StandardError.BaseStream.CopyToAsync($errorStream)
    $inputTask = $inputStream.CopyToAsync($child.StandardInput.BaseStream)

    try { [void]$inputTask.GetAwaiter().GetResult() } catch [System.IO.IOException] { } catch [System.ObjectDisposedException] { }
    try { $child.StandardInput.Close() } catch { }
    $child.WaitForExit()
    $exitCode = $child.ExitCode
    $copyTask = [System.Threading.Tasks.Task]::WhenAll(
        [System.Threading.Tasks.Task[]]@($outputTask, $errorTask)
    )
    $copyCompleted = $copyTask.Wait(500)
    if ($copyCompleted) {
        [void]$copyTask.GetAwaiter().GetResult()
    }
    else {
        try { $child.StandardOutput.BaseStream.Close() } catch { }
        try { $child.StandardError.BaseStream.Close() } catch { }
        try { [void]$copyTask.Wait(500) } catch { }
    }
    $outputStream.Flush()
    $errorStream.Flush()
    exit $exitCode
}
finally {
    if ($started -and -not $child.HasExited) {
        try { $child.Kill() } catch { }
        try { [void]$child.WaitForExit(5000) } catch { }
    }
    $child.Dispose()
    $inputStream.Dispose()
}
'@
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$TimeoutMs,
        [hashtable]$EnvironmentOverrides = @{}
    )

    $targetArguments = (@($Arguments | ForEach-Object { ConvertTo-NativeArgument -Argument $_ }) -join ' ')
    $configuration = [ordered]@{
        filePath = $FilePath
        arguments = $targetArguments
        workingDirectory = $WorkingDirectory
    } | ConvertTo-Json -Compress
    $configurationBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($configuration)
    $encodedConfiguration = [Convert]::ToBase64String($configurationBytes)
    $launcherSource = Get-ContainedProcessLauncherCommand
    $encodedLauncher = [Convert]::ToBase64String(
        [System.Text.Encoding]::Unicode.GetBytes($launcherSource)
    )
    $launcherExecutable = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) {
        throw "Windows PowerShell is unavailable for contained process startup"
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $launcherExecutable
    $startInfo.Arguments = (@(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        $encodedLauncher
    ) | ForEach-Object { ConvertTo-NativeArgument -Argument $_ }) -join ' '
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($name in $EnvironmentOverrides.Keys) {
        $startInfo.EnvironmentVariables[$name] = [string]$EnvironmentOverrides[$name]
    }
    $startInfo.EnvironmentVariables["CAPRO_CONTAINED_PROCESS_CONFIG"] = $encodedConfiguration

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $processJob = $null
    $outputStream = [System.IO.MemoryStream]::new()
    $errorStream = [System.IO.MemoryStream]::new()
    $started = $false
    try {
        $processJob = New-KillOnCloseProcessJob
        $started = $process.Start()
        if (-not $started) { throw "unable to start contained process launcher for $FilePath" }
        $processJob.Assign($process.Handle)
        $outputTask = $process.StandardOutput.BaseStream.CopyToAsync($outputStream)
        $errorTask = $process.StandardError.BaseStream.CopyToAsync($errorStream)
        $process.StandardInput.BaseStream.WriteByte(67)
        $process.StandardInput.BaseStream.Flush()
        $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutMs)) {
            throw "$FilePath timed out after $TimeoutMs ms"
        }
        $processJob.Dispose()
        $processJob = $null
        if (-not $outputTask.Wait(5000) -or -not $errorTask.Wait(5000)) {
            throw "$FilePath output did not close after process exit"
        }
        [byte[]]$outputBytes = $outputStream.ToArray()
        [byte[]]$errorBytes = $errorStream.ToArray()
        $decoder = [System.Text.UTF8Encoding]::new($false)
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $decoder.GetString($outputBytes)
            StandardOutputBytes = $outputBytes
            StandardError = $decoder.GetString($errorBytes)
            StandardErrorBytes = $errorBytes
        }
    }
    finally {
        if ($null -ne $processJob) {
            $processJob.Dispose()
            $processJob = $null
        }
        if ($started -and -not $process.HasExited) {
            try { $process.Kill() } catch { }
            try { [void]$process.WaitForExit(5000) } catch { }
        }
        $process.Dispose()
        $outputStream.Dispose()
        $errorStream.Dispose()
    }
}

function Get-SummaryLine {
    param([AllowNull()][string]$Output)

    if ([string]::IsNullOrWhiteSpace($Output)) { return "" }
    $line = @($Output -split "`r?`n" | Where-Object {
        $_ -match "\d+\s*/\s*\d+|passed|failed|PASS|FAIL|production-ready|vulnerabilit|sha256"
    } | Select-Object -Last 1)
    return (((@($line) -join " ") -replace "\s+", " ").Trim())
}

function Get-GateSummary {
    param(
        [Parameter(Mandatory = $true)][int]$FailureCount,
        [Parameter(Mandatory = $true)][bool]$ArchiveValidationSkipped
    )

    $deploymentReady = $FailureCount -eq 0 -and -not $ArchiveValidationSkipped
    $status = if ($FailureCount -gt 0) {
        "GATES FAILED - DO NOT DEPLOY"
    }
    elseif ($ArchiveValidationSkipped) {
        "PRE-COMMIT GATES GREEN - DEPLOY ARCHIVE NOT VALIDATED"
    }
    else {
        "ALL RELEASE GATES GREEN"
    }
    return @(
        "===== SUMMARY =====",
        "failing gates: $FailureCount",
        ("deployment ready: " + $deploymentReady.ToString().ToLowerInvariant()),
        $status
    )
}

$report.Add("backend release gates")
$report.Add("generated: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
$report.Add("")

try {
    $resolvedRepoRoot = [System.IO.Path]::GetFullPath((Resolve-Path $RepoRoot).Path)
    $resolvedLogPath = [System.IO.Path]::GetFullPath($LogPath)
    $resolvedArchiveOutput = [System.IO.Path]::GetFullPath((Resolve-Path $ArchiveOutputDirectory).Path)
    if (-not (Test-Path -LiteralPath $resolvedRepoRoot -PathType Container)) {
        throw "repository root does not exist"
    }
    $nodeExecutable = Resolve-ApplicationPath -Name "node"
    $powershellExecutable = Resolve-ApplicationPath -Name "powershell"
    $npmCliPath = Join-Path (Split-Path -Parent $nodeExecutable) "node_modules\npm\bin\npm-cli.js"
    if (-not (Test-Path -LiteralPath $npmCliPath -PathType Leaf)) {
        throw "npm CLI was not found beside the resolved Node.js executable"
    }

    $report.Add("===== node --check =====")
    $syntaxFiles = @(
        Get-ChildItem -Path (Join-Path $resolvedRepoRoot "src") -Recurse -Filter *.js -File -ErrorAction Stop
    ) + @(
        Get-ChildItem -Path (Join-Path $resolvedRepoRoot "public") -Recurse -Filter *.js -File -ErrorAction Stop
    )
    $syntaxFiles += Get-Item `
        -LiteralPath (Join-Path $resolvedRepoRoot "tools\scan-deploy-secrets.mjs") `
        -ErrorAction Stop
    $syntaxFiles += Get-Item `
        -LiteralPath (Join-Path $resolvedRepoRoot "tests\deploy-archive-security.mjs") `
        -ErrorAction Stop
    $syntaxFiles += Get-Item `
        -LiteralPath (Join-Path $resolvedRepoRoot "tests\deploy-archive-boundary.mjs") `
        -ErrorAction Stop
    $badSyntax = 0
    foreach ($file in $syntaxFiles) {
        try {
            $result = Invoke-CapturedProcess `
                -FilePath $nodeExecutable `
                -Arguments @("--check", $file.FullName) `
                -WorkingDirectory $resolvedRepoRoot `
                -TimeoutMs 30000 `
                -EnvironmentOverrides @{ NODE_OPTIONS = ""; NODE_PATH = "" }
            if ($result.ExitCode -ne 0) {
                $badSyntax++
                $report.Add("  SYNTAX FAIL " + $file.FullName.Substring($resolvedRepoRoot.Length + 1))
            }
        }
        catch {
            $badSyntax++
            $report.Add("  SYNTAX ERROR " + $file.FullName.Substring($resolvedRepoRoot.Length + 1) + ": " + $_.Exception.Message)
        }
    }
    $report.Add("  files checked: $($syntaxFiles.Count)")
    $report.Add("  files with syntax errors: $badSyntax")
    if ($badSyntax -gt 0) { $failures++ }

    $suites = @(
        "production-readiness-checklist",
        "desktop-token-route",
        "terms-acceptance-contract",
        "workspace-operation-contract",
        "firm-authorization-contract",
        "task-flow-checklist",
        "taxworker-flow-checklist",
        "digest-delivery-correctness",
        "notice-case-contract",
        "shared-backend-contract",
        "production-error-envelope",
        "case-ocr-route-behaviour",
        "error-contract-invariants",
        "gst-owner-authorization-contract",
        "audit-insights-grounding",
        "audit-redaction-references",
        "data-retention-contract",
        "deploy-archive-security",
        "deploy-archive-boundary"
    )
    $report.Add("")
    $report.Add("===== test suites =====")
    foreach ($suite in $suites) {
        $path = Join-Path $resolvedRepoRoot "tests\$suite.mjs"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            $report.Add("  $suite : FILE MISSING")
            $failures++
            continue
        }
        try {
            $timeout = switch ($suite) {
                "digest-delivery-correctness" { $digestTimeoutMs }
                "deploy-archive-boundary" { $boundaryTimeoutMs }
                default { $processTimeoutMs }
            }
            $result = Invoke-CapturedProcess `
                -FilePath $nodeExecutable `
                -Arguments @($path) `
                -WorkingDirectory $resolvedRepoRoot `
                -TimeoutMs $timeout `
                -EnvironmentOverrides @{ NODE_OPTIONS = ""; NODE_PATH = "" }
            $combined = $result.StandardOutput + "`n" + $result.StandardError
            $report.Add("  " + $suite.PadRight(34) + " exit=$($result.ExitCode)  " + (Get-SummaryLine -Output $combined))
            if ($result.ExitCode -ne 0) { $failures++ }
        }
        catch {
            $report.Add("  " + $suite.PadRight(34) + " ERROR  " + $_.Exception.Message)
            $failures++
        }
    }

    $report.Add("")
    $report.Add("===== npm audit (prod, high) =====")
    try {
        $auditResult = Invoke-CapturedProcess `
            -FilePath $nodeExecutable `
            -Arguments @($npmCliPath, "audit", "--omit=dev", "--audit-level=high") `
            -WorkingDirectory $resolvedRepoRoot `
            -TimeoutMs $processTimeoutMs `
            -EnvironmentOverrides @{
                NODE_OPTIONS = ""
                NODE_PATH = ""
                NO_COLOR = "1"
                npm_config_progress = "false"
                npm_config_update_notifier = "false"
            }
        $auditCombined = $auditResult.StandardOutput + "`n" + $auditResult.StandardError
        $report.Add("  exit=$($auditResult.ExitCode)  " + (Get-SummaryLine -Output $auditCombined))
        if ($auditResult.ExitCode -ne 0) { $failures++ }
    }
    catch {
        $report.Add("  ERROR  " + $_.Exception.Message)
        $failures++
    }

    $report.Add("")
    $report.Add("===== commit-pinned archive validation =====")
    if ($SkipDeployArchiveValidation) {
        $report.Add("  SKIPPED by explicit -SkipDeployArchiveValidation")
    }
    else {
        try {
            $builderPath = Join-Path $resolvedRepoRoot "tools\make-deploy-archive.ps1"
            $archiveResult = Invoke-CapturedProcess `
                -FilePath $powershellExecutable `
                -Arguments @(
                    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $builderPath,
                    "-RepoRoot", $resolvedRepoRoot, "-OutputDirectory", $resolvedArchiveOutput, "-ValidateOnly"
                ) `
                -WorkingDirectory $resolvedRepoRoot `
                -TimeoutMs $archiveTimeoutMs
            $archiveCombined = $archiveResult.StandardOutput + "`n" + $archiveResult.StandardError
            $report.Add("  exit=$($archiveResult.ExitCode)  " + (Get-SummaryLine -Output $archiveCombined))
            if ($archiveResult.ExitCode -ne 0) { $failures++ }
        }
        catch {
            $report.Add("  ERROR  " + $_.Exception.Message)
            $failures++
        }
    }
}
catch {
    $report.Add("")
    $report.Add("UNEXPECTED GATE ERROR: " + $_.Exception.Message)
    $failures++
}

$report.Add("")
foreach ($summaryLine in @(Get-GateSummary `
    -FailureCount $failures `
    -ArchiveValidationSkipped $archiveValidationSkipped)) {
    $report.Add($summaryLine)
}

$temporaryLogPath = $resolvedLogPath + ".partial-" + [Guid]::NewGuid().ToString("N")
try {
    Set-Content -LiteralPath $temporaryLogPath -Value ($report -join "`n") -Encoding UTF8 -ErrorAction Stop
    if (Test-Path -LiteralPath $resolvedLogPath -PathType Leaf) {
        $backupLogPath = $resolvedLogPath + ".backup-" + [Guid]::NewGuid().ToString("N")
        [System.IO.File]::Replace($temporaryLogPath, $resolvedLogPath, $backupLogPath, $true)
        Remove-Item -LiteralPath $backupLogPath -Force
    }
    else {
        Move-Item -LiteralPath $temporaryLogPath -Destination $resolvedLogPath
    }
}
catch {
    if (Test-Path -LiteralPath $temporaryLogPath) {
        Remove-Item -LiteralPath $temporaryLogPath -Force
    }
    Write-Error ("unable to write gate log atomically: " + $_.Exception.Message)
    exit 1
}

foreach ($summaryLine in @(
    Get-GateSummary `
        -FailureCount $failures `
        -ArchiveValidationSkipped $archiveValidationSkipped |
        Select-Object -Skip 1
)) {
    Write-Output $summaryLine
}
Write-Output "log written to $resolvedLogPath"
if ($failures -gt 0) { exit 1 }
