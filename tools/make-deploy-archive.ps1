# Builds and validates a commit-pinned Hostinger deployment archive for capro-backend.
#
# Hostinger deploys from an uploaded archive, not from git, so a push alone never changes
# the live API. The server runs npm install during deployment, so node_modules is excluded.
# Only package manifests and the src/public runtime trees are eligible. Every file is bound
# to one Git commit, validated as a regular blob, size-bounded, scanned for credentials, and
# published atomically only after the committed scanner accepts the JavaScript and manifests.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-deploy-archive.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-deploy-archive.ps1 -ValidateOnly

[CmdletBinding()]
param(
    [string]$RepoRoot = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend",
    [string]$OutputDirectory = "D:\CA-PRO-Toolkit",
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$allowedPaths = @("package.json", "package-lock.json", "src", "public")
$requiredEntries = @("package.json", "package-lock.json", "src/server.js")
$scannerRelativePath = "tools/scan-deploy-secrets.mjs"
$acornModuleRelativePath = "node_modules/acorn/dist/acorn.mjs"
$expectedAcornModuleSha256 = "953573B8FDAB71599749EA5F2B33D3E760C2116178F9423EE7458DBE39D59453"
$gitProcessTimeoutMs = 30000
$scannerProcessTimeoutMs = 60000
$staleArtifactMinimumAge = [TimeSpan]::FromHours(24)
$maxFileCount = 2000
$maxEntryBytes = 32MB
$maxArchiveBytes = 64MB
$maxExpandedBytes = 128MB
$maxJavaScriptBytes = 24MB
$maxScannerPayloadBytes = 32MB
$secretVariableNames = @(
    "MONGODB_URI",
    "MONGO_URI",
    "JWT_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_DESKTOP_CLIENT_SECRET",
    "RESEND_API_KEY",
    "DEEPSEEK_API_KEY"
)
$forbiddenPathSegmentPattern = '(?i)^(?:[^/]*\.env(?:\..*)?|\.npmrc(?:\..*)?|\.?netrc(?:\..*)?|\.git-credentials(?:\..*)?|[^/]*\.(?:pem|pfx|p12|key)|(?:credentials?|secrets?)(?:\..*)?)$'
$allowedRuntimeFilePattern = '(?i)(?:^package(?:-lock)?\.json$|\.(?:cjs|conf|config|css|gif|html|ico|ini|jpeg|jpg|js|json|md|mjs|otf|png|properties|svg|toml|ttf|txt|webp|woff2?|xml|yaml|yml)$)'
$nestedArchiveFilePattern = '(?i)\.(?:7z|bz2|gz|gzip|rar|tar|tgz|xz|zip)$'
$textFilePattern = '(?i)\.(?:cjs|conf|config|css|html|ini|js|json|md|mjs|properties|svg|toml|txt|xml|yaml|yml)$'
$javaScriptFilePattern = '(?i)\.(?:cjs|js|mjs)$'
$strictConfigFilePattern = '(?i)(?:^package(?:-lock)?\.json$|\.(?:conf|config|env|ini|json|properties|toml|xml|yaml|yml)$)'
$regexTimeout = [TimeSpan]::FromSeconds(1)
$regexOptions = [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
$providerSecretPatterns = New-Object 'System.Collections.Generic.List[System.Text.RegularExpressions.Regex]'
foreach ($pattern in @(
    '(?i)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '(?i)mongodb(?:\+srv)?://[^/\s:]+:[^@\s]+@',
    '(?i)\bGOCSPX-[A-Za-z0-9_-]{20,}\b',
    '(?i)\bre_[A-Za-z0-9_-]{20,}\b',
    '(?i)\bsk-[A-Za-z0-9_-]{20,}\b',
    '(?i)\bnpm_[A-Za-z0-9]{20,}\b',
    '(?i)\bgh[pousr]_[A-Za-z0-9]{20,}\b',
    '\bAKIA[0-9A-Z]{16}\b',
    '(?i)\b[rs]k_live_[A-Za-z0-9]{16,}\b',
    '(?i)\bxox[baprs]-[A-Za-z0-9-]{20,}\b',
    '(?i)"client_secret"\s*:\s*"(?!\s*(?:REPLACE_ME|YOUR_|CHANGEME))[^"\r\n]{8,}"'
)) {
    $providerSecretPatterns.Add([regex]::new($pattern, $regexOptions, $regexTimeout))
}
$escapedSecretNames = @($secretVariableNames | ForEach-Object { [regex]::Escape($_) })
$strictSecretIdentifierRegex = [regex]::new(
    '(?i)\b(?:' + ($escapedSecretNames -join '|') + ')\b',
    $regexOptions,
    $regexTimeout
)
$quoteCharacterPattern = '["' + [char]39 + ']'
$genericSecretAssignmentRegex = [regex]::new(
    '(?im)(?:^|[;,{(<>\r\n])\s*(?:(?:const|let|var)\s+)?' +
        $quoteCharacterPattern + '?(?:' + ($escapedSecretNames -join '|') + ')' +
        $quoteCharacterPattern + '?\s*(?:=|:)\s*' +
        '(?<quote>' + $quoteCharacterPattern + ')(?<value>[^"' + [char]39 + '\r\n]{1,4096})\k<quote>',
    $regexOptions,
    $regexTimeout
)
$genericSecretPlaceholderRegex = [regex]::new(
    '(?i)^\s*(?:REPLACE_ME|YOUR_[A-Z0-9_]*|CHANGEME|\$\{[A-Z][A-Z0-9_]*\})\s*$',
    $regexOptions,
    $regexTimeout
)
$encodedConfigEscapeRegex = [regex]::new(
    '(?i)\\(?:u[0-9a-f]{4}|u[0-9a-f]{8}|x[0-9a-f]{2})|%(?:[0-9a-f]{2})|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);',
    $regexOptions,
    $regexTimeout
)
$utf8Decoder = [System.Text.UTF8Encoding]::new($false, $true)
$utf8Encoder = [System.Text.UTF8Encoding]::new($false)
$utf16LittleEndianDecoder = [System.Text.UnicodeEncoding]::new($false, $true, $true)
$utf16BigEndianDecoder = [System.Text.UnicodeEncoding]::new($true, $true, $true)
$bytePreservingDecoder = [System.Text.Encoding]::GetEncoding(28591)
$dangerousGitEnvironmentNames = @(
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_EXEC_PATH",
    "GIT_REPLACE_REF_BASE"
)

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Argument)

    if ($Argument.Length -eq 0) { return '""' }
    if ($Argument -notmatch '[\s"]') { return $Argument }

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq [char]92) {
            $backslashes++
            continue
        }
        if ($character -eq [char]34) {
            if ($backslashes -gt 0) {
                [void]$builder.Append(((@('\') * ($backslashes * 2 + 1)) -join ''))
            }
            else {
                [void]$builder.Append('\')
            }
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(((@('\') * $backslashes) -join ''))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(((@('\') * ($backslashes * 2)) -join ''))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Get-RemainingTimeout {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Stopwatch,
        [Parameter(Mandatory = $true)][int]$TimeoutMs,
        [Parameter(Mandatory = $true)][string]$Operation
    )

    $remaining = $TimeoutMs - [int]$Stopwatch.ElapsedMilliseconds
    if ($remaining -le 0) { throw "$Operation timed out" }
    return $remaining
}

function Wait-TaskWithinTimeout {
    param(
        [Parameter(Mandatory = $true)][System.Threading.Tasks.Task]$Task,
        [Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Stopwatch,
        [Parameter(Mandatory = $true)][int]$TimeoutMs,
        [Parameter(Mandatory = $true)][string]$Operation
    )

    $remaining = Get-RemainingTimeout -Stopwatch $Stopwatch -TimeoutMs $TimeoutMs -Operation $Operation
    if (-not $Task.Wait($remaining)) { throw "$Operation timed out" }
    [void]$Task.GetAwaiter().GetResult()
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

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$TimeoutMs,
        [AllowNull()][byte[]]$StandardInput = $null,
        [switch]$CaptureBinaryOutput,
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
    if ($startInfo.PSObject.Properties.Name -contains "StandardOutputEncoding") {
        $startInfo.StandardOutputEncoding = $utf8Encoder
        $startInfo.StandardErrorEncoding = $utf8Encoder
    }
    foreach ($name in $EnvironmentOverrides.Keys) {
        $startInfo.EnvironmentVariables[$name] = [string]$EnvironmentOverrides[$name]
    }
    $startInfo.EnvironmentVariables["CAPRO_CONTAINED_PROCESS_CONFIG"] = $encodedConfiguration

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $processJob = $null
    $outputStream = if ($CaptureBinaryOutput) { [System.IO.MemoryStream]::new() } else { $null }
    $errorStream = [System.IO.MemoryStream]::new()
    $started = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $processJob = New-KillOnCloseProcessJob
        $started = $process.Start()
        if (-not $started) { throw "unable to start contained process launcher for $FilePath" }
        $processJob.Assign($process.Handle)

        if ($CaptureBinaryOutput) {
            $outputTask = $process.StandardOutput.BaseStream.CopyToAsync($outputStream)
        }
        else {
            $outputTask = $process.StandardOutput.ReadToEndAsync()
        }
        $errorTask = $process.StandardError.BaseStream.CopyToAsync($errorStream)

        $process.StandardInput.BaseStream.WriteByte(67)
        $process.StandardInput.BaseStream.Flush()
        if ($null -ne $StandardInput -and $StandardInput.Length -gt 0) {
            $inputTask = $process.StandardInput.BaseStream.WriteAsync(
                $StandardInput,
                0,
                $StandardInput.Length
            )
            Wait-TaskWithinTimeout `
                -Task $inputTask `
                -Stopwatch $stopwatch `
                -TimeoutMs $TimeoutMs `
                -Operation $FilePath
        }
        $process.StandardInput.Close()

        $remaining = Get-RemainingTimeout -Stopwatch $stopwatch -TimeoutMs $TimeoutMs -Operation $FilePath
        if (-not $process.WaitForExit($remaining)) { throw "$FilePath timed out" }
        $processJob.Dispose()
        $processJob = $null
        Wait-TaskWithinTimeout `
            -Task $outputTask `
            -Stopwatch $stopwatch `
            -TimeoutMs $TimeoutMs `
            -Operation $FilePath
        Wait-TaskWithinTimeout `
            -Task $errorTask `
            -Stopwatch $stopwatch `
            -TimeoutMs $TimeoutMs `
            -Operation $FilePath

        [byte[]]$errorBytes = $errorStream.ToArray()
        $result = [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $null
            StandardOutputBytes = $null
            StandardError = $utf8Encoder.GetString($errorBytes)
            StandardErrorBytes = $errorBytes
        }
        if ($CaptureBinaryOutput) {
            [byte[]]$outputBytes = $outputStream.ToArray()
            $result.StandardOutput = $outputBytes
            $result.StandardOutputBytes = $outputBytes
        }
        else {
            $result.StandardOutput = $outputTask.GetAwaiter().GetResult()
        }
        return $result
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
        $stopwatch.Stop()
        $process.Dispose()
        if ($null -ne $outputStream) { $outputStream.Dispose() }
        $errorStream.Dispose()
    }
}

function Resolve-ApplicationPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    $commands = @(Get-Command $Name -CommandType Application -All -ErrorAction Stop)
    if ($commands.Count -eq 0) { throw "required executable is unavailable: $Name" }
    $path = [System.IO.Path]::GetFullPath($commands[0].Source)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "resolved executable does not exist: $path"
    }
    return $path
}

function Invoke-GitCommand {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [byte[]]$StandardInput = $null,
        [switch]$CaptureBinaryOutput
    )

    $result = Invoke-BoundedProcess `
        -FilePath $script:gitExecutable `
        -Arguments $Arguments `
        -WorkingDirectory $RepositoryPath `
        -TimeoutMs $gitProcessTimeoutMs `
        -StandardInput $StandardInput `
        -CaptureBinaryOutput:$CaptureBinaryOutput `
        -EnvironmentOverrides @{ GIT_NO_REPLACE_OBJECTS = "1" }
    if ($result.ExitCode -ne 0) {
        $detail = $result.StandardError.Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) {
            $detail = "git exited with code $($result.ExitCode)"
        }
        throw $detail
    }
    return $result.StandardOutput
}

function Get-GitBlobObjectId {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$RepositoryPath
    )

    $output = Invoke-GitCommand `
        -Arguments @("hash-object", "--stdin") `
        -RepositoryPath $RepositoryPath `
        -StandardInput $Bytes
    $objectId = $output.Trim()
    if ($objectId -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "git hash-object returned a malformed object ID"
    }
    return $objectId
}

function Get-GitBlobBytes {
    param(
        [Parameter(Mandatory = $true)][string]$ObjectId,
        [Parameter(Mandatory = $true)][string]$RepositoryPath
    )

    if ($ObjectId -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "cannot read a malformed Git object ID"
    }
    return Invoke-GitCommand `
        -Arguments @("cat-file", "blob", $ObjectId) `
        -RepositoryPath $RepositoryPath `
        -CaptureBinaryOutput
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($Bytes)) -replace '-', '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-StreamSha256Hex {
    param([Parameter(Mandatory = $true)][System.IO.Stream]$Stream)

    $originalPosition = $Stream.Position
    $Stream.Position = 0
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($Stream)) -replace '-', '')
    }
    finally {
        $sha256.Dispose()
        $Stream.Position = $originalPosition
    }
}

function Remove-StaleOwnedArtifacts {
    param(
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [Parameter(Mandatory = $true)][TimeSpan]$MinimumAge
    )

    if ($MinimumAge -le [TimeSpan]::Zero) {
        throw "stale artifact minimum age must be positive"
    }
    $cutoff = [DateTime]::UtcNow.Subtract($MinimumAge)
    foreach ($item in @(Get-ChildItem -LiteralPath $OutputPath -Force -ErrorAction Stop)) {
        $isOwnedBuildDirectory =
            $item.PSIsContainer -and
            $item.Name -cmatch '^\.capro-build-[0-9a-f]{32}$'
        $isOwnedPartialArchive =
            -not $item.PSIsContainer -and
            $item.Name -cmatch '^\.capro-backend_[0-9]{8}_[0-9]{6}\.zip\.partial-[0-9a-f]{32}$'
        if (-not $isOwnedBuildDirectory -and -not $isOwnedPartialArchive) { continue }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if ($item.LastWriteTimeUtc -gt $cutoff) { continue }

        try {
            if ($isOwnedBuildDirectory) {
                Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
            }
            else {
                Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
            }
        }
        catch {
            if (Test-Path -LiteralPath $item.FullName) {
                throw "unable to remove stale builder artifact $($item.FullName): $($_.Exception.Message)"
            }
        }
    }
}

function New-PrivateDirectory {
    param([Parameter(Mandatory = $true)][string]$ParentPath)

    $path = Join-Path $ParentPath (".capro-build-" + [Guid]::NewGuid().ToString("N"))
    $directory = [System.IO.Directory]::CreateDirectory($path)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
    $directory.SetAccessControl($security)
    return $directory.FullName
}

function New-LockedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes
    )

    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::Read
    )
    try {
        if ($Bytes.Length -gt 0) { $stream.Write($Bytes, 0, $Bytes.Length) }
        $stream.Flush($true)
        return $stream
    }
    catch {
        $stream.Dispose()
        throw
    }
}

function Get-Zip64CentralValues {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][long]$ExtraOffset,
        [Parameter(Mandatory = $true)][int]$ExtraLength,
        [Parameter(Mandatory = $true)][bool]$NeedUncompressedSize,
        [Parameter(Mandatory = $true)][bool]$NeedCompressedSize,
        [Parameter(Mandatory = $true)][bool]$NeedLocalOffset,
        [Parameter(Mandatory = $true)][bool]$NeedDiskStart
    )

    [long]$extraEnd = $ExtraOffset + $ExtraLength
    if (
        $ExtraOffset -lt 0 -or
        $ExtraLength -lt 0 -or
        $extraEnd -lt $ExtraOffset -or
        $extraEnd -gt $Bytes.Length
    ) {
        return $null
    }

    [long]$cursor = $ExtraOffset
    while ($cursor + 4 -le $extraEnd) {
        $headerId = [BitConverter]::ToUInt16($Bytes, [int]$cursor)
        $dataLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 2)
        [long]$dataCursor = $cursor + 4
        [long]$dataEnd = $dataCursor + $dataLength
        if ($dataEnd -gt $extraEnd) { return $null }
        if ($headerId -eq 0x0001) {
            [uint64]$uncompressedSize = 0
            [uint64]$compressedSize = 0
            [uint64]$localOffset = 0
            [uint32]$diskStart = 0
            if ($NeedUncompressedSize) {
                if ($dataCursor + 8 -gt $dataEnd) { return $null }
                $uncompressedSize = [BitConverter]::ToUInt64($Bytes, [int]$dataCursor)
                $dataCursor += 8
            }
            if ($NeedCompressedSize) {
                if ($dataCursor + 8 -gt $dataEnd) { return $null }
                $compressedSize = [BitConverter]::ToUInt64($Bytes, [int]$dataCursor)
                $dataCursor += 8
            }
            if ($NeedLocalOffset) {
                if ($dataCursor + 8 -gt $dataEnd) { return $null }
                $localOffset = [BitConverter]::ToUInt64($Bytes, [int]$dataCursor)
                $dataCursor += 8
            }
            if ($NeedDiskStart) {
                if ($dataCursor + 4 -gt $dataEnd) { return $null }
                $diskStart = [BitConverter]::ToUInt32($Bytes, [int]$dataCursor)
            }
            return [pscustomobject]@{
                UncompressedSize = $uncompressedSize
                CompressedSize = $compressedSize
                LocalOffset = $localOffset
                DiskStart = $diskStart
            }
        }
        $cursor = $dataEnd
    }
    return $null
}

function Test-ZipCentralDirectoryRecords {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][long]$ArchiveStart,
        [Parameter(Mandatory = $true)][long]$CentralStart,
        [Parameter(Mandatory = $true)][long]$CentralEnd,
        [Parameter(Mandatory = $true)][uint64]$EntriesTotal
    )

    if (
        $ArchiveStart -lt 0 -or
        $CentralStart -lt $ArchiveStart -or
        $CentralEnd -lt $CentralStart -or
        $CentralEnd -gt $Bytes.Length
    ) {
        return $false
    }
    [uint64]$maximumEntryCount = [uint64](($CentralEnd - $CentralStart) / 46)
    if ($EntriesTotal -gt $maximumEntryCount) { return $false }

    [long]$cursor = $CentralStart
    [uint64]$entryCount = 0
    $seenArchiveExtraData = $false
    $seenDigitalSignature = $false
    while ($cursor -lt $CentralEnd) {
        if ($seenDigitalSignature -or $cursor + 4 -gt $CentralEnd) { return $false }
        $signature = [BitConverter]::ToUInt32($Bytes, [int]$cursor)

        if ($signature -eq 0x02014B50) {
            if ($entryCount -ge $EntriesTotal -or $cursor + 46 -gt $CentralEnd) {
                return $false
            }
            $nameLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 28)
            $extraLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 30)
            $commentLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 32)
            [long]$recordEnd = $cursor + 46 + $nameLength + $extraLength + $commentLength
            if ($recordEnd -gt $CentralEnd) { return $false }

            [uint64]$uncompressedSize = [BitConverter]::ToUInt32($Bytes, [int]$cursor + 24)
            [uint64]$compressedSize = [BitConverter]::ToUInt32($Bytes, [int]$cursor + 20)
            [uint64]$localRelativeOffset = [BitConverter]::ToUInt32($Bytes, [int]$cursor + 42)
            [uint32]$diskStart = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 34)
            $needUncompressedSize = $uncompressedSize -eq [uint32]::MaxValue
            $needCompressedSize = $compressedSize -eq [uint32]::MaxValue
            $needLocalOffset = $localRelativeOffset -eq [uint32]::MaxValue
            $needDiskStart = $diskStart -eq [uint16]::MaxValue
            if ($needUncompressedSize -or $needCompressedSize -or $needLocalOffset -or $needDiskStart) {
                $zip64 = Get-Zip64CentralValues `
                    -Bytes $Bytes `
                    -ExtraOffset ($cursor + 46 + $nameLength) `
                    -ExtraLength $extraLength `
                    -NeedUncompressedSize $needUncompressedSize `
                    -NeedCompressedSize $needCompressedSize `
                    -NeedLocalOffset $needLocalOffset `
                    -NeedDiskStart $needDiskStart
                if ($null -eq $zip64) { return $false }
                if ($needUncompressedSize) { $uncompressedSize = $zip64.UncompressedSize }
                if ($needCompressedSize) { $compressedSize = $zip64.CompressedSize }
                if ($needLocalOffset) { $localRelativeOffset = $zip64.LocalOffset }
                if ($needDiskStart) { $diskStart = $zip64.DiskStart }
            }
            if ($diskStart -ne 0 -or $localRelativeOffset -gt [uint64]($CentralStart - $ArchiveStart)) {
                return $false
            }

            [long]$localOffset = $ArchiveStart + [long]$localRelativeOffset
            if (
                $localOffset -lt $ArchiveStart -or
                $localOffset + 30 -gt $CentralStart -or
                [BitConverter]::ToUInt32($Bytes, [int]$localOffset) -ne 0x04034B50
            ) {
                return $false
            }
            $localNameLength = [BitConverter]::ToUInt16($Bytes, [int]$localOffset + 26)
            $localExtraLength = [BitConverter]::ToUInt16($Bytes, [int]$localOffset + 28)
            [long]$localDataOffset = $localOffset + 30 + $localNameLength + $localExtraLength
            if (
                $localNameLength -ne $nameLength -or
                $localDataOffset -gt $CentralStart -or
                $compressedSize -gt [uint64]($CentralStart - $localDataOffset)
            ) {
                return $false
            }
            for ($nameIndex = 0; $nameIndex -lt $nameLength; $nameIndex++) {
                if (
                    $Bytes[$localOffset + 30 + $nameIndex] -ne
                    $Bytes[$cursor + 46 + $nameIndex]
                ) {
                    return $false
                }
            }
            $entryCount++
            $cursor = $recordEnd
            continue
        }

        if ($signature -eq 0x08064B50) {
            if ($seenArchiveExtraData -or $entryCount -ne 0 -or $cursor + 8 -gt $CentralEnd) {
                return $false
            }
            [uint64]$extraDataLength = [BitConverter]::ToUInt32($Bytes, [int]$cursor + 4)
            if ($extraDataLength -gt [uint64]($CentralEnd - $cursor - 8)) { return $false }
            $seenArchiveExtraData = $true
            $cursor += 8 + [long]$extraDataLength
            continue
        }

        if ($signature -eq 0x05054B50) {
            if ($entryCount -ne $EntriesTotal -or $cursor + 6 -gt $CentralEnd) {
                return $false
            }
            $signatureLength = [BitConverter]::ToUInt16($Bytes, [int]$cursor + 4)
            [long]$signatureEnd = $cursor + 6 + $signatureLength
            if ($signatureEnd -ne $CentralEnd) { return $false }
            $seenDigitalSignature = $true
            $cursor = $signatureEnd
            continue
        }

        return $false
    }
    return $entryCount -eq $EntriesTotal
}

function Test-CoherentZipArchive {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes)

    if ($Bytes.Length -lt 22) { return $false }
    $content = $bytePreservingDecoder.GetString($Bytes)
    $endSignature = $bytePreservingDecoder.GetString([byte[]]@(0x50, 0x4B, 0x05, 0x06))
    $zip64EndSignature = $bytePreservingDecoder.GetString([byte[]]@(0x50, 0x4B, 0x06, 0x06))
    $zip64LocatorSignature = [byte[]]@(0x50, 0x4B, 0x06, 0x07)
    $searchOffset = 0
    $candidateCount = 0

    while ($searchOffset -le $content.Length - 4) {
        $endOffset = $content.IndexOf(
            $endSignature,
            $searchOffset,
            [System.StringComparison]::Ordinal
        )
        if ($endOffset -lt 0) { break }
        $searchOffset = $endOffset + 1
        $candidateCount++
        if ($candidateCount -gt 4096) { return $true }
        if ($endOffset + 22 -gt $Bytes.Length) { continue }

        $commentLength = [BitConverter]::ToUInt16($Bytes, $endOffset + 20)
        if ($endOffset + 22 + $commentLength -gt $Bytes.Length) { continue }
        $diskNumber = [BitConverter]::ToUInt16($Bytes, $endOffset + 4)
        $centralDiskNumber = [BitConverter]::ToUInt16($Bytes, $endOffset + 6)
        $entriesOnDisk = [BitConverter]::ToUInt16($Bytes, $endOffset + 8)
        $entriesTotal = [BitConverter]::ToUInt16($Bytes, $endOffset + 10)
        [long]$centralSize = [BitConverter]::ToUInt32($Bytes, $endOffset + 12)
        [long]$centralRelativeOffset = [BitConverter]::ToUInt32($Bytes, $endOffset + 16)

        $usesZip64 =
            $entriesOnDisk -eq [uint16]::MaxValue -or
            $entriesTotal -eq [uint16]::MaxValue -or
            $centralSize -eq [uint32]::MaxValue -or
            $centralRelativeOffset -eq [uint32]::MaxValue
        if ($usesZip64) {
            $locatorOffset = $endOffset - 20
            if ($locatorOffset -lt 0) { continue }
            if (
                $Bytes[$locatorOffset] -ne $zip64LocatorSignature[0] -or
                $Bytes[$locatorOffset + 1] -ne $zip64LocatorSignature[1] -or
                $Bytes[$locatorOffset + 2] -ne $zip64LocatorSignature[2] -or
                $Bytes[$locatorOffset + 3] -ne $zip64LocatorSignature[3]
            ) {
                continue
            }
            if (
                [BitConverter]::ToUInt32($Bytes, $locatorOffset + 4) -ne 0 -or
                [BitConverter]::ToUInt32($Bytes, $locatorOffset + 16) -ne 1
            ) {
                continue
            }
            [uint64]$zip64RelativeOffset = [BitConverter]::ToUInt64($Bytes, $locatorOffset + 8)
            if ($zip64RelativeOffset -gt [long]::MaxValue -or $locatorOffset -eq 0) { continue }
            $zip64Offset = $content.LastIndexOf(
                $zip64EndSignature,
                $locatorOffset - 1,
                $locatorOffset,
                [System.StringComparison]::Ordinal
            )
            if ($zip64Offset -lt 0 -or $zip64Offset + 56 -gt $locatorOffset) { continue }
            [uint64]$zip64RecordSize = [BitConverter]::ToUInt64($Bytes, $zip64Offset + 4)
            if (
                $zip64RecordSize -lt 44 -or
                $zip64RecordSize -gt [long]::MaxValue -or
                $zip64Offset + 12 + [long]$zip64RecordSize -ne $locatorOffset
            ) {
                continue
            }
            if (
                [BitConverter]::ToUInt32($Bytes, $zip64Offset + 16) -ne 0 -or
                [BitConverter]::ToUInt32($Bytes, $zip64Offset + 20) -ne 0
            ) {
                continue
            }
            [uint64]$zip64EntriesOnDisk = [BitConverter]::ToUInt64($Bytes, $zip64Offset + 24)
            [uint64]$zip64EntriesTotal = [BitConverter]::ToUInt64($Bytes, $zip64Offset + 32)
            [uint64]$zip64CentralSize = [BitConverter]::ToUInt64($Bytes, $zip64Offset + 40)
            [uint64]$zip64CentralOffset = [BitConverter]::ToUInt64($Bytes, $zip64Offset + 48)
            if (
                $zip64EntriesOnDisk -ne $zip64EntriesTotal -or
                $zip64CentralSize -gt [long]::MaxValue -or
                $zip64CentralOffset -gt [long]::MaxValue -or
                ($entriesOnDisk -ne [uint16]::MaxValue -and [uint64]$entriesOnDisk -ne $zip64EntriesOnDisk) -or
                ($entriesTotal -ne [uint16]::MaxValue -and [uint64]$entriesTotal -ne $zip64EntriesTotal) -or
                ($centralSize -ne [uint32]::MaxValue -and [uint64]$centralSize -ne $zip64CentralSize) -or
                ($centralRelativeOffset -ne [uint32]::MaxValue -and [uint64]$centralRelativeOffset -ne $zip64CentralOffset)
            ) {
                continue
            }
            [long]$zip64ArchiveStart = $zip64Offset - [long]$zip64RelativeOffset
            [long]$zip64CentralStart = $zip64Offset - [long]$zip64CentralSize
            if (
                $zip64ArchiveStart -lt 0 -or
                $zip64CentralStart -lt $zip64ArchiveStart -or
                $zip64CentralStart - [long]$zip64CentralOffset -ne $zip64ArchiveStart
            ) {
                continue
            }
            if (Test-ZipCentralDirectoryRecords `
                -Bytes $Bytes `
                -ArchiveStart $zip64ArchiveStart `
                -CentralStart $zip64CentralStart `
                -CentralEnd $zip64Offset `
                -EntriesTotal $zip64EntriesTotal
            ) {
                return $true
            }
            continue
        }

        if (
            $diskNumber -ne 0 -or
            $centralDiskNumber -ne 0 -or
            $entriesOnDisk -ne $entriesTotal -or
            $centralSize -gt $endOffset
        ) {
            continue
        }
        [long]$centralStart = $endOffset - $centralSize
        [long]$archiveStart = $centralStart - $centralRelativeOffset
        if ($archiveStart -lt 0 -or $centralStart -lt $archiveStart) { continue }
        if (Test-ZipCentralDirectoryRecords `
            -Bytes $Bytes `
            -ArchiveStart $archiveStart `
            -CentralStart $centralStart `
            -CentralEnd $endOffset `
            -EntriesTotal ([uint64]$entriesTotal)
        ) {
            return $true
        }
    }
    return $false
}

function Test-NestedArchiveMagic {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes)

    if ($Bytes.Length -lt 2) { return $false }
    if (Test-CoherentZipArchive -Bytes $Bytes) { return $true }
    $content = $bytePreservingDecoder.GetString($Bytes)
    $strongSignatures = @(
        [byte[]]@(0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00),
        [byte[]]@(0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00),
        [byte[]]@(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C),
        [byte[]]@(0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00)
    )
    foreach ($signatureBytes in $strongSignatures) {
        $signature = $bytePreservingDecoder.GetString($signatureBytes)
        if ($content.IndexOf($signature, [System.StringComparison]::Ordinal) -ge 0) {
            return $true
        }
    }

    $gzipSignature = $bytePreservingDecoder.GetString([byte[]]@(0x1F, 0x8B, 0x08))
    $gzipIndex = $content.IndexOf($gzipSignature, [System.StringComparison]::Ordinal)
    while ($gzipIndex -ge 0) {
        if ($gzipIndex + 18 -le $Bytes.Length) {
            $flags = $Bytes[$gzipIndex + 3]
            if (($flags -band 0xE0) -eq 0) {
                [long]$headerCursor = $gzipIndex + 10
                $headerValid = $true
                if (($flags -band 0x04) -ne 0) {
                    if ($headerCursor + 2 -gt $Bytes.Length) {
                        $headerValid = $false
                    }
                    else {
                        $extraLength = [BitConverter]::ToUInt16($Bytes, $headerCursor)
                        $headerCursor += 2 + $extraLength
                    }
                }
                foreach ($zeroTerminatedFlag in @(0x08, 0x10)) {
                    if ($headerValid -and ($flags -band $zeroTerminatedFlag) -ne 0) {
                        while ($headerCursor -lt $Bytes.Length -and $Bytes[$headerCursor] -ne 0) {
                            $headerCursor++
                        }
                        if ($headerCursor -ge $Bytes.Length) {
                            $headerValid = $false
                        }
                        else {
                            $headerCursor++
                        }
                    }
                }
                if ($headerValid -and ($flags -band 0x02) -ne 0) { $headerCursor += 2 }
                if ($headerValid -and $headerCursor + 8 -le $Bytes.Length) { return $true }
            }
        }
        $gzipIndex = $content.IndexOf(
            $gzipSignature,
            $gzipIndex + 1,
            [System.StringComparison]::Ordinal
        )
    }

    $bzipIndex = $content.IndexOf("BZh", [System.StringComparison]::Ordinal)
    $bzipBlockMagic = $bytePreservingDecoder.GetString([byte[]]@(0x31, 0x41, 0x59, 0x26, 0x53, 0x59))
    $bzipEndMagic = $bytePreservingDecoder.GetString([byte[]]@(0x17, 0x72, 0x45, 0x38, 0x50, 0x90))
    while ($bzipIndex -ge 0) {
        if (
            $bzipIndex + 10 -le $Bytes.Length -and
            $Bytes[$bzipIndex + 3] -ge 0x31 -and
            $Bytes[$bzipIndex + 3] -le 0x39
        ) {
            $blockMarker = $content.Substring($bzipIndex + 4, 6)
            if ($blockMarker -eq $bzipBlockMagic -or $blockMarker -eq $bzipEndMagic) {
                return $true
            }
        }
        $bzipIndex = $content.IndexOf(
            "BZh",
            $bzipIndex + 1,
            [System.StringComparison]::Ordinal
        )
    }

    $tarIndex = $content.IndexOf("ustar", [System.StringComparison]::Ordinal)
    while ($tarIndex -ge 0) {
        $headerOffset = $tarIndex - 257
        if ($headerOffset -ge 0 -and $headerOffset + 512 -le $Bytes.Length) {
            $hasName = $false
            for ($nameIndex = 0; $nameIndex -lt 100; $nameIndex++) {
                if ($Bytes[$headerOffset + $nameIndex] -ne 0) {
                    $hasName = $true
                    break
                }
            }
            $checksumText = [System.Text.Encoding]::ASCII.GetString(
                $Bytes,
                $headerOffset + 148,
                8
            ).Trim([char[]]@(0, 32))
            if ($hasName -and $checksumText -match '^[0-7]{1,6}$') {
                try {
                    $expectedChecksum = [Convert]::ToInt64($checksumText, 8)
                    [long]$actualChecksum = 0
                    for ($headerIndex = 0; $headerIndex -lt 512; $headerIndex++) {
                        if ($headerIndex -ge 148 -and $headerIndex -lt 156) {
                            $actualChecksum += 32
                        }
                        else {
                            $actualChecksum += $Bytes[$headerOffset + $headerIndex]
                        }
                    }
                    if ($actualChecksum -eq $expectedChecksum) { return $true }
                }
                catch [System.FormatException] { }
                catch [System.OverflowException] { }
            }
        }
        $tarIndex = $content.IndexOf(
            "ustar",
            $tarIndex + 1,
            [System.StringComparison]::Ordinal
        )
    }
    return $false
}

function Get-SecretScanTextViews {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes)

    $views = New-Object 'System.Collections.Generic.List[string]'
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $latin = $bytePreservingDecoder.GetString($Bytes)
    if ($seen.Add($latin)) { $views.Add($latin) }
    try {
        $utf8 = $utf8Decoder.GetString($Bytes)
        if ($seen.Add($utf8)) { $views.Add($utf8) }
    }
    catch [System.Text.DecoderFallbackException] { }

    $nullBytes = 0
    foreach ($value in $Bytes) { if ($value -eq 0) { $nullBytes++ } }
    $looksUtf16 = $Bytes.Length -ge 2 -and (
        ($Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) -or
        ($Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) -or
        ($nullBytes * 5 -ge $Bytes.Length)
    )
    if ($looksUtf16) {
        foreach ($decoder in @($utf16LittleEndianDecoder, $utf16BigEndianDecoder)) {
            try {
                $decoded = $decoder.GetString($Bytes)
                if ($seen.Add($decoded)) { $views.Add($decoded) }
            }
            catch [System.Text.DecoderFallbackException] { }
        }
    }
    return $views.ToArray()
}

function Invoke-ArchiveContentScan {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Files,
        [Parameter(Mandatory = $true)][string[]]$SecretNames,
        [Parameter(Mandatory = $true)][string]$PackageJson,
        [Parameter(Mandatory = $true)][string]$PackageLock,
        [Parameter(Mandatory = $true)][string]$ScannerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryPath
    )

    $payload = [ordered]@{
        mode = "archive"
        files = @($Files)
        secretNames = @($SecretNames)
        manifests = [ordered]@{
            packageJson = $PackageJson
            packageLock = $PackageLock
        }
    } | ConvertTo-Json -Depth 5 -Compress
    $payloadBytes = $utf8Encoder.GetBytes($payload)
    if ($payloadBytes.Length -gt $maxScannerPayloadBytes) {
        throw "JavaScript secret-scan payload exceeds 32 MB"
    }

    $result = Invoke-BoundedProcess `
        -FilePath $script:nodeExecutable `
        -Arguments @($ScannerPath) `
        -WorkingDirectory $RepositoryPath `
        -TimeoutMs $scannerProcessTimeoutMs `
        -StandardInput $payloadBytes `
        -EnvironmentOverrides @{ NODE_OPTIONS = ""; NODE_PATH = "" }
    if ($result.ExitCode -ne 0) {
        $detail = $result.StandardError.Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) {
            $detail = "scanner exited with code $($result.ExitCode)"
        }
        throw "JavaScript secret scan failed: $detail"
    }
    return $result.StandardOutput.Trim()
}

$workingDirectory = $null
$partialArchivePath = $null
$archivePath = $null
$createdFinalArchive = $false
$buildSucceeded = $false
$failureMessage = $null
$scannerLock = $null
$acornLock = $null
$archive = $null
$archiveSourceStream = $null
$commit = $null
$fileCount = 0
$validatedArchiveHash = $null
$validatedArchiveLength = 0
$javaScriptScanSummary = $null
$gitVersion = $null
$nodeVersion = $null

try {
    if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
        throw "backend repository does not exist: $RepoRoot"
    }
    if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
        throw "archive output directory does not exist: $OutputDirectory"
    }
    foreach ($environmentName in $dangerousGitEnvironmentNames) {
        $environmentValue = [Environment]::GetEnvironmentVariable($environmentName, "Process")
        if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
            throw "$environmentName must be unset while building an archive"
        }
    }

    $script:gitExecutable = Resolve-ApplicationPath -Name "git"
    $script:nodeExecutable = Resolve-ApplicationPath -Name "node"
    $resolvedRepoRoot = [System.IO.Path]::GetFullPath((Resolve-Path $RepoRoot).Path).TrimEnd([char]92, [char]47)
    $resolvedOutputDirectory = [System.IO.Path]::GetFullPath((Resolve-Path $OutputDirectory).Path).TrimEnd([char]92, [char]47)
    Remove-StaleOwnedArtifacts `
        -OutputPath $resolvedOutputDirectory `
        -MinimumAge $staleArtifactMinimumAge

    $topLevel = (Invoke-GitCommand `
        -Arguments @("-C", $resolvedRepoRoot, "rev-parse", "--show-toplevel") `
        -RepositoryPath $resolvedRepoRoot).Trim()
    $resolvedTopLevel = [System.IO.Path]::GetFullPath($topLevel).TrimEnd([char]92, [char]47)
    if (-not [string]::Equals(
        $resolvedRepoRoot,
        $resolvedTopLevel,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "RepoRoot is not the resolved Git top-level directory"
    }

    $commit = (Invoke-GitCommand `
        -Arguments @("-C", $resolvedRepoRoot, "rev-parse", "--verify", "HEAD^{commit}") `
        -RepositoryPath $resolvedRepoRoot).Trim()
    if ($commit -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "unable to resolve a valid backend HEAD commit"
    }
    $trackedStatus = Invoke-GitCommand `
        -Arguments @("-C", $resolvedRepoRoot, "status", "--porcelain=v1", "--untracked-files=no") `
        -RepositoryPath $resolvedRepoRoot
    if (-not [string]::IsNullOrWhiteSpace($trackedStatus)) {
        throw "tracked backend files differ from HEAD; commit or restore them first`n$trackedStatus"
    }
    $headAfterStatus = (Invoke-GitCommand `
        -Arguments @("-C", $resolvedRepoRoot, "rev-parse", "--verify", "HEAD^{commit}") `
        -RepositoryPath $resolvedRepoRoot).Trim()
    if ($headAfterStatus -ne $commit) { throw "backend HEAD changed while checking the worktree" }

    $gitVersion = (Invoke-GitCommand -Arguments @("--version") -RepositoryPath $resolvedRepoRoot).Trim()
    $nodeVersionResult = Invoke-BoundedProcess `
        -FilePath $script:nodeExecutable `
        -Arguments @("--version") `
        -WorkingDirectory $resolvedRepoRoot `
        -TimeoutMs $gitProcessTimeoutMs `
        -EnvironmentOverrides @{ NODE_OPTIONS = ""; NODE_PATH = "" }
    if ($nodeVersionResult.ExitCode -ne 0) { throw "unable to resolve the Node.js version" }
    $nodeVersion = $nodeVersionResult.StandardOutput.Trim()

    $scannerTreeOutput = (Invoke-GitCommand `
        -Arguments @(
            "-C", $resolvedRepoRoot, "ls-tree",
            "--format=%(objectmode)%x09%(objectname)", $commit, "--", $scannerRelativePath
        ) `
        -RepositoryPath $resolvedRepoRoot).TrimEnd("`r", "`n")
    $scannerRecords = @($scannerTreeOutput -split "`r?`n" | Where-Object { $_.Length -gt 0 })
    if ($scannerRecords.Count -ne 1) {
        throw "JavaScript secret scanner is not committed at $commit"
    }
    $scannerSeparator = $scannerRecords[0].IndexOf("`t")
    if ($scannerSeparator -le 0) { throw "JavaScript secret scanner has malformed tree metadata" }
    $scannerMode = $scannerRecords[0].Substring(0, $scannerSeparator)
    $scannerObjectId = $scannerRecords[0].Substring($scannerSeparator + 1).Trim()
    if ($scannerMode -notin @("100644", "100755") -or $scannerObjectId -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "JavaScript secret scanner is not a regular committed blob"
    }
    $scannerBlobBytes = Get-GitBlobBytes -ObjectId $scannerObjectId -RepositoryPath $resolvedRepoRoot

    $acornModulePath = Join-Path $resolvedRepoRoot $acornModuleRelativePath
    if (-not (Test-Path -LiteralPath $acornModulePath -PathType Leaf)) {
        throw "pinned Acorn module is not installed: $acornModulePath"
    }
    $acornInput = [System.IO.File]::Open(
        $acornModulePath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        $acornMemory = [System.IO.MemoryStream]::new()
        try {
            $acornInput.CopyTo($acornMemory)
            $acornModuleBytes = $acornMemory.ToArray()
        }
        finally {
            $acornMemory.Dispose()
        }
    }
    finally {
        $acornInput.Dispose()
    }
    $actualAcornModuleSha256 = Get-Sha256Hex -Bytes $acornModuleBytes
    if (-not [string]::Equals(
        $actualAcornModuleSha256,
        $expectedAcornModuleSha256,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "installed Acorn module does not match the pinned file hash"
    }

    $treeBytes = Invoke-GitCommand `
        -Arguments (@(
            "-C", $resolvedRepoRoot, "ls-tree", "-r", "-z",
            "--format=%(objectmode)%x09%(objectname)%x09%(objectsize)%x09%(path)", $commit, "--"
        ) + $allowedPaths) `
        -RepositoryPath $resolvedRepoRoot `
        -CaptureBinaryOutput
    $treeText = $utf8Decoder.GetString($treeBytes)
    $treeRecords = @($treeText -split "`0" | Where-Object { $_.Length -gt 0 })
    $expectedEntryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $expectedObjectIds = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    [long]$selectedExpandedBytes = 0
    foreach ($record in $treeRecords) {
        $modeSeparator = $record.IndexOf("`t")
        $objectSeparator = $record.IndexOf("`t", $modeSeparator + 1)
        $sizeSeparator = $record.IndexOf("`t", $objectSeparator + 1)
        if (
            $modeSeparator -le 0 -or
            $objectSeparator -le $modeSeparator + 1 -or
            $sizeSeparator -le $objectSeparator + 1
        ) {
            throw "malformed git tree record"
        }
        $mode = $record.Substring(0, $modeSeparator)
        $objectId = $record.Substring($modeSeparator + 1, $objectSeparator - $modeSeparator - 1)
        $objectSizeText = $record.Substring(
            $objectSeparator + 1,
            $sizeSeparator - $objectSeparator - 1
        )
        $entryPath = $record.Substring($sizeSeparator + 1)
        if ($mode -notin @("100644", "100755")) {
            throw "runtime tree contains a non-regular file ($mode): $entryPath"
        }
        if ($objectId -notmatch '^[0-9a-fA-F]{40,64}$') {
            throw "runtime tree contains a malformed object ID: $entryPath"
        }
        if ($objectSizeText -notmatch '^\d+$') {
            throw "runtime tree contains an invalid blob size: $entryPath"
        }
        try {
            [long]$objectSize = [Convert]::ToInt64(
                $objectSizeText,
                [System.Globalization.CultureInfo]::InvariantCulture
            )
        }
        catch {
            throw "runtime tree contains an invalid blob size: $entryPath"
        }
        if ($objectSize -gt $maxEntryBytes) {
            throw "committed blob exceeds the per-file size limit before archive creation: $entryPath"
        }
        $selectedExpandedBytes += $objectSize
        if ($selectedExpandedBytes -gt $maxExpandedBytes) {
            throw "selected runtime tree exceeds the expanded-size limit before archive creation"
        }
        if (-not $expectedEntryNames.Add($entryPath)) {
            throw "runtime tree contains a duplicate path: $entryPath"
        }
        $expectedObjectIds.Add($entryPath, $objectId)
    }
    if ($expectedEntryNames.Count -eq 0 -or $expectedEntryNames.Count -gt $maxFileCount) {
        throw "selected runtime tree has an invalid file count"
    }

    $workingDirectory = New-PrivateDirectory -ParentPath $resolvedOutputDirectory
    $scannerDirectory = [System.IO.Directory]::CreateDirectory((Join-Path $workingDirectory "tools")).FullName
    $acornDirectory = [System.IO.Directory]::CreateDirectory(
        (Join-Path $workingDirectory "node_modules\acorn\dist")
    ).FullName
    $temporaryScannerPath = Join-Path $scannerDirectory "scan-deploy-secrets.mjs"
    $temporaryAcornPath = Join-Path $acornDirectory "acorn.mjs"
    $scannerLock = New-LockedFile -Path $temporaryScannerPath -Bytes $scannerBlobBytes
    $acornLock = New-LockedFile -Path $temporaryAcornPath -Bytes $acornModuleBytes

    $candidateArchivePath = Join-Path $workingDirectory "candidate.zip"
    $archiveResult = Invoke-BoundedProcess `
        -FilePath $script:gitExecutable `
        -Arguments (@(
            "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-C", $resolvedRepoRoot,
            "archive", "--format=zip", "--output=$candidateArchivePath", $commit, "--"
        ) + $allowedPaths) `
        -WorkingDirectory $resolvedRepoRoot `
        -TimeoutMs $gitProcessTimeoutMs `
        -EnvironmentOverrides @{ GIT_NO_REPLACE_OBJECTS = "1" }
    if ($archiveResult.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $candidateArchivePath -PathType Leaf)) {
        throw "git archive failed for commit $commit`: $($archiveResult.StandardError.Trim())"
    }
    $candidateLength = (Get-Item -LiteralPath $candidateArchivePath).Length
    if ($candidateLength -le 0 -or $candidateLength -gt $maxArchiveBytes) {
        throw "candidate archive exceeds the compressed-size limit"
    }

    $archiveSourceStream = [System.IO.File]::Open(
        $candidateArchivePath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $archive = [System.IO.Compression.ZipArchive]::new(
        $archiveSourceStream,
        [System.IO.Compression.ZipArchiveMode]::Read,
        $true
    )
    $fileEntries = New-Object System.Collections.Generic.List[object]
    $canonicalArchivePaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $archiveFileNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($entry in $archive.Entries) {
        $entryPath = $entry.FullName
        $normalizedPath = $entryPath.TrimEnd("/")
        $pathSegments = @($normalizedPath -split "/")
        $canonicalPath = $normalizedPath.Normalize([System.Text.NormalizationForm]::FormC)
        $hasUnsafeSegment = @($pathSegments | Where-Object {
            $_.Length -eq 0 -or $_ -eq "." -or $_ -eq ".." -or $_.EndsWith(" ") -or $_.EndsWith(".")
        }).Count -gt 0
        $hasControlCharacter = $false
        foreach ($character in $entryPath.ToCharArray()) {
            if ([char]::IsControl($character)) { $hasControlCharacter = $true; break }
        }
        if (
            [string]::IsNullOrWhiteSpace($entryPath) -or
            [string]::IsNullOrWhiteSpace($normalizedPath) -or
            $entryPath.Contains("\") -or
            $entryPath.Contains("//") -or
            $entryPath.Contains(":") -or
            $entryPath.StartsWith("/") -or
            $hasUnsafeSegment -or
            $hasControlCharacter
        ) {
            throw "archive contains an unsafe path: $entryPath"
        }
        if (-not $canonicalArchivePaths.Add($canonicalPath)) {
            throw "archive contains an extraction-equivalent duplicate path: $entryPath"
        }

        $isAllowed =
            $normalizedPath -eq "package.json" -or
            $normalizedPath -eq "package-lock.json" -or
            $normalizedPath -eq "src" -or
            $normalizedPath.StartsWith("src/") -or
            $normalizedPath -eq "public" -or
            $normalizedPath.StartsWith("public/")
        if (-not $isAllowed) { throw "archive contains a path outside the runtime allowlist: $entryPath" }
        foreach ($segment in $pathSegments) {
            if ($segment -match $forbiddenPathSegmentPattern) {
                throw "archive contains a forbidden secret-bearing path: $entryPath"
            }
        }

        $unixMode = (([uint32]$entry.ExternalAttributes -shr 16) -band 0xFFFF)
        $fileType = $unixMode -band 0xF000
        $isDirectory = [string]::IsNullOrEmpty($entry.Name)
        if (
            $fileType -ne 0 -and
            (($isDirectory -and $fileType -ne 0x4000) -or (-not $isDirectory -and $fileType -ne 0x8000))
        ) {
            throw "archive contains non-regular extraction metadata: $entryPath"
        }
        if ($isDirectory) { continue }
        if ($entryPath -notmatch $allowedRuntimeFilePattern) {
            throw "archive contains an unapproved runtime file type: $entryPath"
        }
        if ($entryPath -match $nestedArchiveFilePattern) {
            throw "archive contains a nested archive: $entryPath"
        }
        if ($entry.Length -lt 0 -or $entry.Length -gt $maxEntryBytes) {
            throw "archive entry exceeds the per-file size limit: $entryPath"
        }
        if (-not $archiveFileNames.Add($entryPath)) {
            throw "archive contains a duplicate file: $entryPath"
        }
        $fileEntries.Add($entry)
    }

    if ($archiveFileNames.Count -ne $expectedEntryNames.Count) {
        throw "archive file count differs from the selected commit tree"
    }
    foreach ($expected in $expectedEntryNames) {
        if (-not $archiveFileNames.Contains($expected)) {
            throw "archive is missing selected commit file: $expected"
        }
    }
    foreach ($actual in $archiveFileNames) {
        if (-not $expectedEntryNames.Contains($actual)) {
            throw "archive contains a file outside the selected commit tree: $actual"
        }
    }
    foreach ($required in $requiredEntries) {
        if (-not $archiveFileNames.Contains($required)) {
            throw "archive is missing $required; deploying it would take the API down"
        }
    }

    $javaScriptFiles = New-Object System.Collections.Generic.List[object]
    [long]$expandedBytes = 0
    [long]$javaScriptBytes = 0
    $packageJsonSource = $null
    $packageLockSource = $null
    foreach ($entry in $fileEntries) {
        $expandedBytes += $entry.Length
        if ($expandedBytes -gt $maxExpandedBytes) {
            throw "archive exceeds the expanded-size limit"
        }
        $entryStream = $entry.Open()
        $memoryStream = [System.IO.MemoryStream]::new()
        try {
            $entryStream.CopyTo($memoryStream)
            $entryBytes = $memoryStream.ToArray()
        }
        finally {
            $entryStream.Dispose()
            $memoryStream.Dispose()
        }
        if (Test-NestedArchiveMagic -Bytes $entryBytes) {
            throw "archive contains nested archive bytes: $($entry.FullName)"
        }

        $actualObjectId = Get-GitBlobObjectId -Bytes $entryBytes -RepositoryPath $resolvedRepoRoot
        $expectedObjectId = $expectedObjectIds[$entry.FullName]
        if (-not [string]::Equals(
            $actualObjectId,
            $expectedObjectId,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "archive bytes differ from committed blob: $($entry.FullName)"
        }

        try {
            foreach ($scanContent in @(Get-SecretScanTextViews -Bytes $entryBytes)) {
                foreach ($pattern in $providerSecretPatterns) {
                    if ($pattern.IsMatch($scanContent)) {
                        throw "archive content matched a provider secret pattern: $($entry.FullName)"
                    }
                }
            }
        }
        catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
            throw "archive provider secret scan timed out: $($entry.FullName)"
        }

        if ($entry.FullName -notmatch $textFilePattern) { continue }
        try {
            $content = $utf8Decoder.GetString($entryBytes)
        }
        catch [System.Text.DecoderFallbackException] {
            throw "archive text entry is not valid UTF-8: $($entry.FullName)"
        }
        if ($entry.FullName -match $strictConfigFilePattern) {
            try {
                if ($encodedConfigEscapeRegex.IsMatch($content)) {
                    throw "structured runtime config must not contain encoded escapes: $($entry.FullName)"
                }
                if ($strictSecretIdentifierRegex.IsMatch($content)) {
                    throw "structured runtime config must not contain secret identifiers: $($entry.FullName)"
                }
            }
            catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
                throw "archive structured-config scan timed out: $($entry.FullName)"
            }
        }

        if ($entry.FullName -notmatch $javaScriptFilePattern) {
            try {
                foreach ($match in $genericSecretAssignmentRegex.Matches($content)) {
                    if (-not $genericSecretPlaceholderRegex.IsMatch($match.Groups['value'].Value)) {
                        throw "archive text contains a hardcoded secret assignment: $($entry.FullName)"
                    }
                }
            }
            catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
                throw "archive generic secret-assignment scan timed out: $($entry.FullName)"
            }
        }

        if ($entry.FullName -eq "package.json") { $packageJsonSource = $content }
        if ($entry.FullName -eq "package-lock.json") { $packageLockSource = $content }
        if ($entry.FullName -match $javaScriptFilePattern) {
            $javaScriptBytes += $entryBytes.Length
            if ($javaScriptBytes -gt $maxJavaScriptBytes) {
                throw "archive JavaScript exceeds the aggregate scan limit"
            }
            $javaScriptFiles.Add([pscustomobject]@{ path = $entry.FullName; source = $content })
        }
    }
    if ($null -eq $packageJsonSource -or $null -eq $packageLockSource) {
        throw "archive manifests were not readable"
    }

    $javaScriptScanSummary = Invoke-ArchiveContentScan `
        -Files $javaScriptFiles.ToArray() `
        -SecretNames $secretVariableNames `
        -PackageJson $packageJsonSource `
        -PackageLock $packageLockSource `
        -ScannerPath $temporaryScannerPath `
        -RepositoryPath $resolvedRepoRoot
    $fileCount = $fileEntries.Count

    $archive.Dispose()
    $archive = $null
    $validatedArchiveHash = Get-StreamSha256Hex -Stream $archiveSourceStream
    $validatedArchiveLength = $archiveSourceStream.Length

    $finalHead = (Invoke-GitCommand `
        -Arguments @("-C", $resolvedRepoRoot, "rev-parse", "--verify", "HEAD^{commit}") `
        -RepositoryPath $resolvedRepoRoot).Trim()
    if ($finalHead -ne $commit) { throw "backend HEAD changed during archive validation" }
    $finalStatus = Invoke-GitCommand `
        -Arguments @("-C", $resolvedRepoRoot, "status", "--porcelain=v1", "--untracked-files=no") `
        -RepositoryPath $resolvedRepoRoot
    if (-not [string]::IsNullOrWhiteSpace($finalStatus)) {
        throw "tracked backend files changed during archive validation"
    }

    if (-not $ValidateOnly) {
        $stamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
        $archiveName = "capro-backend_$stamp.zip"
        $archivePath = Join-Path $resolvedOutputDirectory $archiveName
        $partialArchivePath = Join-Path $resolvedOutputDirectory (
            ".$archiveName.partial-" + [Guid]::NewGuid().ToString("N")
        )
        if (Test-Path -LiteralPath $archivePath) {
            throw "archive destination already exists: $archivePath"
        }
        $publicationStream = [System.IO.File]::Open(
            $partialArchivePath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $archiveSourceStream.Position = 0
            $archiveSourceStream.CopyTo($publicationStream)
            $publicationStream.Flush($true)
        }
        finally {
            $publicationStream.Dispose()
        }
        $partialHash = (Get-FileHash -LiteralPath $partialArchivePath -Algorithm SHA256).Hash
        if ($partialHash -ne $validatedArchiveHash) {
            throw "publication copy differs from the validated archive"
        }
        Move-Item -LiteralPath $partialArchivePath -Destination $archivePath
        $partialArchivePath = $null
        $createdFinalArchive = $true
        $finalHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
        if ($finalHash -ne $validatedArchiveHash) {
            throw "published archive differs from the validated archive"
        }
    }

    $buildSucceeded = $true
}
catch {
    $failureMessage = $_.Exception.Message
}
finally {
    if ($null -ne $archive) { $archive.Dispose() }
    if ($null -ne $archiveSourceStream) { $archiveSourceStream.Dispose() }
    if ($null -ne $scannerLock) { $scannerLock.Dispose() }
    if ($null -ne $acornLock) { $acornLock.Dispose() }
    if ($null -ne $partialArchivePath -and (Test-Path -LiteralPath $partialArchivePath)) {
        Remove-Item -LiteralPath $partialArchivePath -Force
    }
    if (-not $buildSucceeded -and $createdFinalArchive -and (Test-Path -LiteralPath $archivePath)) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    if ($null -ne $workingDirectory -and (Test-Path -LiteralPath $workingDirectory)) {
        Remove-Item -LiteralPath $workingDirectory -Recurse -Force
    }
}

if (-not $buildSucceeded) {
    Write-Output ("REFUSED: " + $failureMessage)
    exit 1
}
if (-not [string]::IsNullOrWhiteSpace($javaScriptScanSummary)) {
    Write-Output $javaScriptScanSummary
}
Write-Output ("commit        : " + $commit)
Write-Output ("files archived: " + $fileCount)
Write-Output ("git           : " + $gitVersion + " @ " + $script:gitExecutable)
Write-Output ("node          : " + $nodeVersion + " @ " + $script:nodeExecutable)
if ($ValidateOnly) {
    Write-Output "archive       : validation only (not published)"
}
else {
    Write-Output ("archive       : " + $archivePath)
}
Write-Output ("size          : " + [math]::Round($validatedArchiveLength / 1MB, 2) + " MB")
Write-Output ("sha256        : " + $validatedArchiveHash)
