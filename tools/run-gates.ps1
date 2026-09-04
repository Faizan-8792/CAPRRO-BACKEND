# Runs the backend release gates and writes one plain-text summary.
# By default this includes commit-pinned deployment archive validation, which requires a clean
# tracked worktree. Use -SkipDeployArchiveValidation only for pre-commit development checks.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-gates.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-gates.ps1 -SkipDeployArchiveValidation

[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$LogPath,
    [string]$ArchiveOutputDirectory = "D:\CA-PRO-Toolkit",
    [switch]$SkipDeployArchiveValidation
)

$ErrorActionPreference = "Stop"

# Resolved here, not as param defaults above: $PSScriptRoot is not yet bound while parameter
# defaults are evaluated under PowerShell 5.1 -File. Previously hardcoded to the shared checkout
# (D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend), which silently ran the gates against a
# DIFFERENT copy of the code than whichever one this script actually lives inside -- invoked from a
# git worktree with no override, it would validate the wrong tree and report false confidence about
# the one actually being worked on. $ArchiveOutputDirectory is deliberately NOT changed: it is the
# shared workspace-level archive retention location (CLAUDE.md's own documented convention), meant
# to accumulate deploy archives from every worktree/session in one place regardless of which one
# built them, since rollback needs to find them later no matter where it runs from.
if (-not $RepoRoot) {
    $toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $RepoRoot = Split-Path -Parent $toolsDir
}
if (-not $LogPath) {
    $LogPath = Join-Path $RepoRoot "gates.log"
}
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
#
# RAISED 2026-08-26: 900,000 was NOT above the worst run. This suite timed out at
# exactly 900,000ms inside the runner on a machine where it completes standalone,
# and it invokes make-deploy-archive.ps1 dozens of times, so its cost tracks how
# busy the box is rather than what the code does. A timeout is indistinguishable
# from a real failure in the report, which is the worse outcome.
#
# The objection the paragraph above raises against a looser bound is real, and it
# is answered by measuring instead of only bounding: every suite line now carries
# its own elapsed time, so a suite that doubles in cost shows up as a number in
# the log rather than being hidden by the wider cap. Compare two logs, not two
# recollections.
$boundaryTimeoutMs = 1500000

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
# The parent writes exactly one byte, 67, and nothing else. But Windows PowerShell builds the
# parent's StandardInput StreamWriter from [Console]::InputEncoding with AutoFlush on, and that
# flush emits the encoding's PREAMBLE into this pipe before the parent's own byte. On a UTF-8
# console - Windows 11's "Beta: use Unicode UTF-8 for worldwide language support", and what most
# modern terminals set - the preamble is EF BB BF, so reading the first byte strictly saw 239 and
# refused EVERY launch. Measured 2026-08-26: run-gates.ps1 reported all 50 suites, npm audit, the
# commit-pinned archive validation and 165 node --check calls as failures with nothing whatsoever
# wrong with any of them, and make-deploy-archive.ps1 could not build a deploy archive at all.
# .NET Framework exposes no ProcessStartInfo.StandardInputEncoding to switch the preamble off, so
# the handshake skips a leading byte-order mark rather than assuming the platform never inserts
# one. Pinned by tools/contained-launcher.tests.ps1, which feeds each preamble explicitly.
$handshake = $inputStream.ReadByte()
$markRemainder = @()
if ($handshake -eq 239) { $markRemainder = @(187, 191) }
elseif ($handshake -eq 255) { $markRemainder = @(254) }
elseif ($handshake -eq 254) { $markRemainder = @(255) }
foreach ($expectedByte in $markRemainder) {
    if ($inputStream.ReadByte() -ne $expectedByte) {
        throw "contained process launch was not authorized"
    }
}
if ($markRemainder.Count -gt 0) { $handshake = $inputStream.ReadByte() }
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
    # Measured so the report can carry it. A cap alone only ever tells you "under the bound" or
    # "over it"; the elapsed figure is what makes a suite that doubled in cost visible in a diff of
    # two logs, which is the objection against ever widening a cap.
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
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
        $stopwatch.Stop()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $decoder.GetString($outputBytes)
            StandardOutputBytes = $outputBytes
            StandardError = $decoder.GetString($errorBytes)
            StandardErrorBytes = $errorBytes
            ElapsedMs = [int]$stopwatch.Elapsed.TotalMilliseconds
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

function ConvertFrom-ClixmlText {
    # A nested Windows PowerShell writes its errors to stderr as CLIXML, not as text. Reported raw
    # it fills the line with markup and buries the one sentence that says what went wrong - which is
    # how a launcher failure once read as 53 unrelated gate failures. This lifts the message text
    # out. It is deliberately a regex rather than an XML parse: the payload is often truncated, and
    # a parser would throw on exactly the malformed input this most needs to survive.
    param([AllowNull()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    if ($Text -notmatch "^\s*#<\s*CLIXML") { return $Text }
    $messages = [regex]::Matches($Text, "<S(?:\s+S=`"[^`"]*`")?>(.*?)</S>", "Singleline")
    if ($messages.Count -eq 0) { return $Text }
    $decoded = foreach ($message in $messages) {
        $value = $message.Groups[1].Value
        $value = $value -replace "_x000D_", "" -replace "_x000A_", "`n" -replace "_x0009_", " "
        [System.Net.WebUtility]::HtmlDecode($value)
    }
    return (($decoded -join "`n").Trim())
}

function Format-Elapsed {
    param([AllowNull()]$Result)

    if ($null -eq $Result -or $null -eq $Result.ElapsedMs) { return "" }
    $seconds = [math]::Round($Result.ElapsedMs / 1000.0, 1)
    return ("{0,7:0.0}s  " -f $seconds)
}

function Get-SummaryLine {
    param([AllowNull()][string]$Output)

    if ([string]::IsNullOrWhiteSpace($Output)) { return "" }
    $text = ConvertFrom-ClixmlText -Text $Output
    $line = @($text -split "`r?`n" | Where-Object {
        $_ -match "\d+\s*/\s*\d+|passed|failed|PASS|FAIL|production-ready|vulnerabilit|sha256"
    } | Select-Object -Last 1)
    $summary = (((@($line) -join " ") -replace "\s+", " ").Trim())
    if (-not [string]::IsNullOrWhiteSpace($summary)) { return $summary }
    # Nothing matched the interesting-token list. An empty summary beside a non-zero exit code tells
    # the reader nothing, so fall back to the first line of real text - which is where an
    # infrastructure failure, as opposed to a test failure, always states itself.
    $first = @($text -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -First 1)
    return (((@($first) -join " ") -replace "\s+", " ").Trim())
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

    # Informational only - this section can never fail the run. It exists because two separate gate
    # defects on 2026-08-26 were both "the result depends on the operator's environment, and the log
    # did not say what that environment was": the launcher handshake broke under a UTF-8 console
    # ([Console]::InputEncoding preamble), and deploy-archive-boundary passed under Git Bash's GNU tar
    # and failed under PowerShell's bsdtar. Neither was visible in the log, so both read as code
    # failures. Recording the facts the gates actually depend on makes the NEXT such divergence
    # visible in a diff of two logs rather than a day of bisecting.
    $report.Add("===== environment =====")
    function Add-EnvironmentFact {
        param([string]$Label, [scriptblock]$Probe)
        try {
            $value = & $Probe
            if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { $value = "(none)" }
            $report.Add("  " + $Label.PadRight(26) + ([string]$value).Trim())
        }
        catch {
            $report.Add("  " + $Label.PadRight(26) + "(unavailable: " + $_.Exception.Message + ")")
        }
    }
    Add-EnvironmentFact "node" { (& $nodeExecutable --version) }
    Add-EnvironmentFact "node path" { $nodeExecutable }
    Add-EnvironmentFact "powershell" { $PSVersionTable.PSVersion.ToString() }
    Add-EnvironmentFact "console input encoding" {
        [Console]::InputEncoding.WebName + " (preamble " + [Console]::InputEncoding.GetPreamble().Length + " bytes)"
    }
    Add-EnvironmentFact "console output encoding" { [Console]::OutputEncoding.WebName }
    Add-EnvironmentFact "tar on PATH" {
        $tarCommand = @(Get-Command tar -CommandType Application -All -ErrorAction SilentlyContinue)
        if ($tarCommand.Count -eq 0) { "(not on PATH)" }
        else { (@(& $tarCommand[0].Source --version 2>$null)[0]) + "  <- " + $tarCommand[0].Source }
    }
    Add-EnvironmentFact "git" { (& git --version) }
    Add-EnvironmentFact "NODE_ENV" { $env:NODE_ENV }
    Add-EnvironmentFact "current culture" { [System.Globalization.CultureInfo]::CurrentCulture.Name }
    $report.Add("")

    # FIRST of the real gates, deliberately. Every one below runs its child through the
    # contained-process launcher, so when the launcher's stdin handshake breaks, all of them fail at
    # once and each one reads like a real defect in the thing it was testing. That happened on
    # 2026-08-26: 53 failing gates, none of them real. This section names that cause near the top of
    # the report instead of leaving 53 misleading ones to be read as code failures.
    $report.Add("===== contained launcher handshake =====")
    $launcherTestPath = Join-Path $resolvedRepoRoot "tools\contained-launcher.tests.ps1"
    if (-not (Test-Path -LiteralPath $launcherTestPath -PathType Leaf)) {
        $report.Add("  MISSING tools\contained-launcher.tests.ps1")
        $failures++
    }
    else {
        try {
            $launcherResult = Invoke-CapturedProcess `
                -FilePath $powershellExecutable `
                -Arguments @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", $launcherTestPath, "-RepoRoot", $resolvedRepoRoot) `
                -WorkingDirectory $resolvedRepoRoot `
                -TimeoutMs $processTimeoutMs
            $launcherCombined = $launcherResult.StandardOutput + "`n" + $launcherResult.StandardError
            $report.Add("  exit=$($launcherResult.ExitCode)  " + (Format-Elapsed -Result $launcherResult) + (Get-SummaryLine -Output $launcherCombined))
            if ($launcherResult.ExitCode -ne 0) { $failures++ }
        }
        catch {
            $report.Add("  ERROR  " + $_.Exception.Message)
            $failures++
        }
    }

    $report.Add("")
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
        -LiteralPath (Join-Path $resolvedRepoRoot "tools\scan-repo-secrets.mjs") `
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
                # The reason belongs on the line. Reported as a bare filename, a launcher failure
                # that hits every file is indistinguishable from 165 real syntax errors, and that is
                # exactly how one was once misread.
                $reason = Get-SummaryLine -Output ($result.StandardError + "`n" + $result.StandardOutput)
                if ([string]::IsNullOrWhiteSpace($reason)) { $reason = "exit=$($result.ExitCode), no output" }
                $report.Add("  SYNTAX FAIL " + $file.FullName.Substring($resolvedRepoRoot.Length + 1) + "  " + $reason)
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
        "task-date-contract",
        "taxworker-flow-checklist",
        "digest-delivery-correctness",
        "digest-frequency-checklist",
        "notice-case-contract",
        "shared-backend-contract",
        "production-error-envelope",
        "case-ocr-route-behaviour",
        "error-contract-invariants",
        "gst-owner-authorization-contract",
        "gst-match-rule-contract",
        "import-shape-contract",
        "import-date-order-contract",
        "gstr2b-amount-contract",
        "audit-numerical-integrity-contract",
        "audit-coverage-gate-contract",
        "audit-finding-guard-contract",
        "audit-insights-grounding",
        "audit-insights-accuracy-speed",
        "audit-insights-coverage-and-discipline",
        "audit-insights-reasoning-pipeline",
        "audit-insights-capability-scorecard",
        "audit-redaction-references",
        "digest-unsubscribe-link",
        "reminder-message-validation",
        "audit-llm-failure-wording",
        "data-retention-contract",
        "audit-topic-catalogue-parity",
        "task-version-guard-contract",
        "taxworker-duplicate-audit-contract",
        "case-verified-references-contract",
        "engagement-reviewer-authorization-contract",
        "deploy-archive-security",
        "deploy-archive-boundary",
        "app-config-checklist",
        "desktop-release-contract",
        "provider-quota-contract",
        "client-version-contract",
        "desktop-fixture-drift-contract",
        # Added 2026-08-26. These six existed in tests/ and passed, but were NEVER in this list, so a
        # regression in any of them would have shipped silently. Found by diffing the suite files on
        # disk (50) against the names in this array (40) -- the same class of hole as the
        # MONGODB_URI one below: a gate that looks comprehensive because nobody counted.
        # `removed-membership-lifecycle` and `admin-feature-flag-save-safety` are the two that matter
        # most: the first guards the REMOVED-member story, the second guards a panel that can wipe
        # production feature flags.
        "admin-feature-flag-save-safety",
        "double-click-guard-checklist",
        "erasure-copy-parity",
        "firm-join-sync-checklist",
        "removed-membership-lifecycle",
        "user-facing-error-contract",
        # Registered here on the day it was added, deliberately: V17's invariant is that the runner
        # executes as many suites as exist in tests/, so a new suite left unregistered breaks that
        # gate rather than merely going unrun.
        "admin-panel-same-origin",
        "desktop-route-discovery-contract",
        "extension-route-parity",
        # T1/T3 (.kiro/PLAN.md), registered the day each was added per the invariant above.
        "reminder-delivery-health-stat",
        "reminder-delivery-alert-scheduler",
        # Added the day the super panel sorting bug was fixed. The panel had a sidebar
        # router and sortable tables in production with nothing asserting either, so a
        # date column that sorted by the American field order shipped unnoticed.
        "super-panel-contract",
        # Ties Core's navigation tags to the App's route catalogue. Core cannot reference App,
        # so every Open button and empty-state action names its destination as a string that
        # nothing verified - a renamed tag left a button that silently did nothing.
        "desktop-navigation-contract",
        # The three reconciliations one GST period needs - books vs 2B (already covered by
        # gst-match-rule-contract), GSTR-1 vs GSTR-3B turnover, and ITC vs the credit ledger -
        # plus the header resolver that finally reaches production. Mutation-tested.
        "gst-control-reconciliation-contract",
        "gst-reconciliation-e2e",
        # The two bulk actions, proved against a real database: each must reach exactly the rows
        # its per-row equivalent would have reached, and no further.
        "bulk-actions-e2e"
    )

    # The other four unwired suites need a REPLICA SET, not just a mongod: they run multi-document
    # transactions, which a standalone server refuses. They already default to
    # 127.0.0.1:27118/...?replicaSet=rs0, so they need no override -- only a check that something is
    # actually listening, so a machine without one reports them as skipped rather than failing a gate
    # for an absent dependency. `cross-tenant-isolation` and the three erasure suites are the
    # highest-consequence tests in this repository: they are what stands behind "data from one firm
    # appeared while working in another" and behind every erasure promise the privacy policy makes.
    $replicaSetSuites = @(
        "cross-tenant-isolation",
        "erasure-request-route",
        "firm-erasure-contract",
        "firm-erasure-e2e"
    )
    # Suites that hold EXTRA assertions behind "if (process.env.MONGODB_URI)". This runner never
    # set that variable, so those assertions had never run in a single gate execution. Measured
    # directly: provider-quota-contract reports 32/32 without it and 38/38 with it, and the six it
    # was skipping are the quota PERSISTENCE checks -- whether a spent counter survives a restart,
    # which is the entire point of a spend cap. A gate that prints a green 32/32 while silently
    # omitting the six assertions that matter most is worse than one that fails.
    #
    # Each suite gets its OWN scratch database so two suites can never see each other's rows, and
    # every name carries the "scratch" marker the suites' own safety guards look for before they
    # will touch a database at all.
    $mongoScratch = @{
        "provider-quota-contract" = "scratch-gates-quota"
        "data-retention-contract" = "scratch-gates-retention"
        "desktop-release-contract" = "scratch-gates-release"
        "terms-acceptance-contract" = "scratch-gates-terms"
        "gst-reconciliation-e2e" = "scratch-gates-gst-e2e"
        "bulk-actions-e2e" = "scratch-gates-bulk"
    }
    # Probed once, not assumed. On a machine with no local Mongo the behaviour is unchanged from
    # before -- the variable stays unset and the suites run their Mongo-free subset -- but the
    # report says so out loud instead of presenting the smaller count as the whole suite.
    $mongoPort = 0
    foreach ($candidate in @(27117, 27017)) {
        try {
            $probe = New-Object System.Net.Sockets.TcpClient
            $async = $probe.BeginConnect("127.0.0.1", $candidate, $null, $null)
            if ($async.AsyncWaitHandle.WaitOne(1500) -and $probe.Connected) { $mongoPort = $candidate }
            $probe.Close()
        }
        catch { }
        if ($mongoPort -ne 0) { break }
    }

    # Same probe, separate port: the four transaction suites need a replica set specifically.
    $replicaSetReachable = $false
    try {
        $rsProbe = New-Object System.Net.Sockets.TcpClient
        $rsAsync = $rsProbe.BeginConnect("127.0.0.1", 27118, $null, $null)
        if ($rsAsync.AsyncWaitHandle.WaitOne(1500) -and $rsProbe.Connected) { $replicaSetReachable = $true }
        $rsProbe.Close()
    }
    catch { }
    if ($replicaSetReachable) { $suites += $replicaSetSuites }

    $report.Add("")
    $report.Add("===== test suites =====")
    if ($mongoPort -ne 0) {
        $report.Add("  (local Mongo on 127.0.0.1:$mongoPort - Mongo-dependent assertions ENABLED for $($mongoScratch.Count) suite(s))")
    } else {
        $report.Add("  (no local Mongo reachable on 27117 or 27017 - the Mongo-dependent assertions in")
        $report.Add("   $($mongoScratch.Keys -join ', ') did NOT run; their printed counts are the Mongo-free subset)")
    }
    if ($replicaSetReachable) {
        $report.Add("  (replica set on 127.0.0.1:27118 - the $($replicaSetSuites.Count) transaction suite(s) INCLUDED: $($replicaSetSuites -join ', '))")
    } else {
        $report.Add("  (no replica set on 127.0.0.1:27118 - SKIPPED, not failed: $($replicaSetSuites -join ', ').")
        $report.Add("   These are the firm-isolation and erasure suites. A run without them is NOT a full gate;")
        $report.Add("   start the replica set and re-run before treating this as green.)")
    }
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
            $suiteEnv = @{ NODE_OPTIONS = ""; NODE_PATH = "" }
            if ($mongoPort -ne 0 -and $mongoScratch.ContainsKey($suite)) {
                $suiteEnv["MONGODB_URI"] = "mongodb://127.0.0.1:$mongoPort/$($mongoScratch[$suite])"
            }
            $result = Invoke-CapturedProcess `
                -FilePath $nodeExecutable `
                -Arguments @($path) `
                -WorkingDirectory $resolvedRepoRoot `
                -TimeoutMs $timeout `
                -EnvironmentOverrides $suiteEnv
            $combined = $result.StandardOutput + "`n" + $result.StandardError
            $report.Add("  " + $suite.PadRight(34) + " exit=$($result.ExitCode)  " + (Format-Elapsed -Result $result) + (Get-SummaryLine -Output $combined))
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
        $report.Add("  exit=$($auditResult.ExitCode)  " + (Format-Elapsed -Result $auditResult) + (Get-SummaryLine -Output $auditCombined))
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
            $report.Add("  exit=$($archiveResult.ExitCode)  " + (Format-Elapsed -Result $archiveResult) + (Get-SummaryLine -Output $archiveCombined))
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
