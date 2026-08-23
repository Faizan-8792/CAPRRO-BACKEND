# Encrypted, verified MongoDB backup for capro-backend (.kiro/finalreleasefix.md O4).
#
# The database is a MongoDB Atlas M0 free-tier cluster in the Mumbai region (PLAN.md section 39).
# M0 has NO backup facility at all -- no snapshots, no point-in-time restore, no
# restore-to-scratch-cluster -- so O4 step 1's "skip the dump script only if O3 chose Atlas M10+
# continuous backup" does not apply. A mongodump-based archive is the only option available, and
# until this script runs on a schedule there is no copy of the production database anywhere.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup-database.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup-database.ps1 -WhatIfNoUpload
#
# THE CREDENTIAL IS NEVER AN ARGV VALUE. -MongoUri defaults to $env:CAPRO_BACKUP_URI, and the URI
# is handed to mongodump/mongosh through a temporary YAML config file (mongodump --config=), not
# through --uri, so it never appears in a process list. The temp file is written with a restrictive
# ACL and removed in a finally block even when the dump throws.
#
# MONGO TOOLS. mongodump/mongorestore/mongosh are not on this machine's PATH. The script prefers
# PATH when they are present and otherwise runs them inside the local Docker container named by
# -MongoToolContainer, dumping to a path inside the container and copying the result out with
# `docker cp`. It deliberately does NOT stream the archive over stdout: PowerShell's pipeline
# mangles binary, and a silently corrupted archive is the exact failure this script exists to
# prevent.

[CmdletBinding()]
param(
    # Defaults to the environment variable so the credential is never typed on a command line.
    [string]$MongoUri = $env:CAPRO_BACKUP_URI,

    [string]$OutputDirectory = "D:\CA-PRO-Toolkit\capro-backups",

    # O3 has not chosen an off-host destination yet. When it does, pass it here (a mapped drive, a
    # synced folder, or an rclone remote mounted as a path). Left empty the script still produces a
    # verified local archive but WARNS loudly, because a backup on the same machine as the developer
    # PC is not an off-host backup.
    [string]$OffHostDirectory = "",

    [int]$Retain = 14,

    # gpg recipient (key id, fingerprint or uid). O4 step 3 allows age or gpg; gpg 2.4.9 is what is
    # installed here. Without a recipient the script refuses to write an unencrypted dump.
    [string]$RecipientKey = $env:CAPRO_BACKUP_RECIPIENT,

    [string]$LogPath = "",

    [string]$MongoToolContainer = "capro-mongo-dev",

    [int]$TimeoutSeconds = 1800,

    # gpg is often not on the system PATH on Windows even when installed; see Resolve-Gpg.
    [string]$GpgPath = "",

    # Produce and verify the archive but skip the off-host copy. Used by the first drill.
    [switch]$WhatIfNoUpload
)

$ErrorActionPreference = "Stop"

$script:LogLines = New-Object System.Collections.Generic.List[string]

function Write-Log([string]$Message) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $line = "$stamp  $Message"
    $script:LogLines.Add($line) | Out-Null
    Write-Output $Message
}

function Write-LogAtomically([string]$Path) {
    # Written once, at the end, via a temp file plus Move so a killed run never leaves a half log
    # that reads as a successful one.
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $tmp = "$Path.$([System.Guid]::NewGuid().ToString('N')).partial"
    Set-Content -LiteralPath $tmp -Value $script:LogLines -Encoding utf8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function ConvertTo-Arg([string]$Value) {
    <#
      Windows PowerShell 5.1 runs on .NET Framework, where ProcessStartInfo has NO ArgumentList
      property - that was added in .NET Core. So arguments must be joined into a single command
      line, quoted by the exact rules CommandLineToArgvW parses back. Doing this by hand rather
      than with a naive "wrap in quotes" is what stops a Mongo URI containing a password with a
      space or a quote from silently becoming two arguments.
    #>
    if ($Value -eq "") { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * ($slashes * 2 + 1)); [void]$sb.Append('"'); $slashes = 0; continue
        }
        if ($slashes -gt 0) { [void]$sb.Append('\' * $slashes); $slashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($slashes -gt 0) { [void]$sb.Append('\' * ($slashes * 2)) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Invoke-Bounded {
    <#
      Runs an external process with a hard timeout and captured output. Every external call in this
      script goes through here: a mongodump that hangs on a network stall must fail the backup, not
      wedge the scheduled task forever.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$Timeout = 600,
        [string]$StdOutFile = ""
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-Arg $_ }) -join ' ')
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEndAsync()
    $stderr = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit($Timeout * 1000)) {
        try { $proc.Kill() } catch { }
        throw "TIMEOUT after ${Timeout}s: $FilePath $($Arguments -join ' ')"
    }

    $outText = $stdout.Result
    $errText = $stderr.Result
    if ($StdOutFile) { Set-Content -LiteralPath $StdOutFile -Value $outText -Encoding utf8 }

    return [pscustomobject]@{
        ExitCode = $proc.ExitCode
        StdOut   = $outText
        StdErr   = $errText
    }
}

function Resolve-Gpg([string]$Explicit) {
    <#
      gpg is frequently NOT on the system PATH on Windows even when it is installed: Git for Windows
      ships one under usr\bin that only Git Bash can see, and Gpg4win installs under Program Files.
      A scheduled task running as a service account gets neither. Resolving it here rather than
      assuming PATH is what stops the nightly backup dying with "gpg is not on PATH" months later.
    #>
    if ($Explicit) {
        if (Test-Path -LiteralPath $Explicit) { return $Explicit }
        throw "-GpgPath was given as '$Explicit' but nothing exists there."
    }
    $onPath = Get-Command "gpg" -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles "Git\usr\bin\gpg.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Git\usr\bin\gpg.exe"),
        (Join-Path $env:ProgramFiles "GnuPG\bin\gpg.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "GnuPG\bin\gpg.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Git\usr\bin\gpg.exe")
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    throw "gpg could not be found on PATH or in any known install location. Pass -GpgPath explicitly."
}

function Get-MongoToolInvocation([string]$Tool) {
    <#
      Returns how to invoke a mongo tool: natively if it is on PATH, otherwise through the local
      Docker container. Returned as a FilePath plus an argument prefix so callers do not have to
      care which one they got.
    #>
    $native = Get-Command $Tool -ErrorAction SilentlyContinue
    if ($native) {
        return [pscustomobject]@{ FilePath = $native.Source; Prefix = @(); InContainer = $false }
    }

    $docker = Get-Command "docker" -ErrorAction SilentlyContinue
    if (-not $docker) {
        throw "$Tool is not on PATH and docker is not available, so there is no way to run it. Install the MongoDB Database Tools or start Docker."
    }

    $probe = Invoke-Bounded -FilePath $docker.Source -Arguments @("exec", $MongoToolContainer, "which", $Tool) -Timeout 60
    if ($probe.ExitCode -ne 0) {
        throw "$Tool is not on PATH and is not present inside container '$MongoToolContainer'. Checked with: docker exec $MongoToolContainer which $Tool"
    }

    return [pscustomobject]@{
        FilePath    = $docker.Source
        Prefix      = @("exec", "-i", $MongoToolContainer)
        InContainer = $true
    }
}

# ----------------------------------------------------------------------------- preflight

Write-Log "==> capro-backend database backup"

if ([string]::IsNullOrWhiteSpace($MongoUri)) {
    throw "No MongoDB URI. Set `$env:CAPRO_BACKUP_URI (preferred, keeps the credential out of argv) or pass -MongoUri."
}
if ([string]::IsNullOrWhiteSpace($RecipientKey)) {
    throw "No -RecipientKey and no `$env:CAPRO_BACKUP_RECIPIENT. Refusing to write an UNENCRYPTED database dump: an unencrypted archive of this database is every firm's client data sitting in a file."
}

$gpgExe = Resolve-Gpg $GpgPath
Write-Log "gpg           : $gpgExe"

# Database name out of the URI, without logging the credential.
$dbName = ""
try {
    $noScheme = $MongoUri -replace '^mongodb(\+srv)?://', ''
    $afterHost = $noScheme.Substring($noScheme.IndexOf('/') + 1)
    $dbName = ($afterHost -split '\?')[0]
} catch { }
if ([string]::IsNullOrWhiteSpace($dbName)) {
    throw "Could not read a database name out of the URI. It must include one, e.g. mongodb+srv://host/capro?retryWrites=true"
}
Write-Log "database      : $dbName"

if (-not (Test-Path -LiteralPath $OutputDirectory)) {
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
}
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $OutputDirectory "backup-database.log"
}

$stampName = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$archiveName = "capro-$dbName-$stampName.archive.gz"
$plainArchive = Join-Path $OutputDirectory $archiveName
$encArchive = "$plainArchive.gpg"
$manifestPath = Join-Path $OutputDirectory "capro-$dbName-$stampName.manifest.json"

$configFile = Join-Path ([System.IO.Path]::GetTempPath()) ("capro-backup-" + [System.Guid]::NewGuid().ToString("N") + ".yaml")
$containerConfig = "/tmp/" + (Split-Path -Leaf $configFile)
$containerArchive = "/tmp/$archiveName"

try {
    # --------------------------------------------------------------- credential-bearing config
    # mongodump --config reads the uri from a YAML file, keeping it out of the process list.
    Set-Content -LiteralPath $configFile -Value ("uri: `"" + $MongoUri + "`"") -Encoding ascii
    try {
        $acl = Get-Acl -LiteralPath $configFile
        $acl.SetAccessRuleProtection($true, $false)
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, "FullControl", "Allow")
        $acl.SetAccessRule($rule)
        Set-Acl -LiteralPath $configFile -AclObject $acl
    } catch {
        Write-Log "warning       : could not tighten the ACL on the temporary config file ($($_.Exception.Message)). It is still removed at the end of this run."
    }

    $dump = Get-MongoToolInvocation "mongodump"
    $shell = Get-MongoToolInvocation "mongosh"

    if ($dump.InContainer) {
        $dockerExe = $dump.FilePath
        $cp = Invoke-Bounded -FilePath $dockerExe -Arguments @("cp", $configFile, "${MongoToolContainer}:$containerConfig") -Timeout 120
        if ($cp.ExitCode -ne 0) { throw "docker cp of the config file failed: $($cp.StdErr)" }
    }

    # ------------------------------------------------------- per-collection counts BEFORE the dump
    # O4 step 4: without these the restore drill has nothing to compare against.
    Write-Log "==> Capturing per-collection document counts"
    $countScript = 'const out={};db.getCollectionNames().sort().forEach(function(c){out[c]=db.getCollection(c).countDocuments({});});print(JSON.stringify(out));'
    $shellArgs = @()
    $shellArgs += $shell.Prefix
    if ($shell.InContainer) { $shellArgs += @("mongosh", "--quiet", "--file", "/dev/stdin") }
    $countArgs = @()
    $countArgs += $shell.Prefix
    if ($shell.InContainer) {
        $countArgs += @("mongosh", $MongoUri, "--quiet", "--eval", $countScript)
    } else {
        $countArgs = @($MongoUri, "--quiet", "--eval", $countScript)
    }
    $countRun = Invoke-Bounded -FilePath $shell.FilePath -Arguments $countArgs -Timeout 300
    if ($countRun.ExitCode -ne 0) {
        throw "Could not read collection counts before the dump: $($countRun.StdErr)"
    }
    $countsJson = ($countRun.StdOut -split "`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if (-not $countsJson) { throw "mongosh returned no JSON count payload. Raw output: $($countRun.StdOut)" }
    $counts = $countsJson | ConvertFrom-Json
    $collectionCount = @($counts.PSObject.Properties).Count
    Write-Log "collections   : $collectionCount"

    # --------------------------------------------------------------------------------- the dump
    Write-Log "==> Dumping"
    $dumpArgs = @()
    $dumpArgs += $dump.Prefix
    if ($dump.InContainer) {
        $dumpArgs += @("mongodump", "--config=$containerConfig", "--gzip", "--archive=$containerArchive")
    } else {
        $dumpArgs += @("--config=$configFile", "--gzip", "--archive=$plainArchive")
    }
    $dumpRun = Invoke-Bounded -FilePath $dump.FilePath -Arguments $dumpArgs -Timeout $TimeoutSeconds
    if ($dumpRun.ExitCode -ne 0) {
        throw "mongodump failed (exit $($dumpRun.ExitCode)): $($dumpRun.StdErr)"
    }

    if ($dump.InContainer) {
        $cpOut = Invoke-Bounded -FilePath $dump.FilePath -Arguments @("cp", "${MongoToolContainer}:$containerArchive", $plainArchive) -Timeout 600
        if ($cpOut.ExitCode -ne 0) { throw "docker cp of the archive failed: $($cpOut.StdErr)" }
    }

    if (-not (Test-Path -LiteralPath $plainArchive)) { throw "mongodump reported success but no archive exists at $plainArchive" }
    $plainSize = (Get-Item -LiteralPath $plainArchive).Length
    Write-Log "archive bytes : $plainSize"
    if ($plainSize -lt 1024) {
        throw "Archive is $plainSize bytes. A dump this small is the classic silent backup failure, not a small database."
    }

    # ------------------------------------------- size sanity against the previous run (O4 step 3)
    $previous = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter "*.manifest.json" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
    if ($previous.Count -eq 1) {
        try {
            $prevManifest = Get-Content -LiteralPath $previous[0].FullName -Raw | ConvertFrom-Json
            $prevSize = [int64]$prevManifest.archiveBytesPlain
            if ($prevSize -gt 0) {
                $ratio = [double]$plainSize / [double]$prevSize
                Write-Log ("size ratio    : {0:N2}x previous ({1} bytes)" -f $ratio, $prevSize)
                if ($ratio -lt 0.1 -or $ratio -gt 10.0) {
                    throw ("Archive size moved by more than an order of magnitude against the previous run ({0} -> {1} bytes). Refusing to treat this as a good backup without a human looking at it." -f $prevSize, $plainSize)
                }
            }
        } catch [System.Management.Automation.RuntimeException] {
            throw
        } catch {
            Write-Log "warning       : could not compare against the previous manifest ($($_.Exception.Message))"
        }
    } else {
        Write-Log "size ratio    : no previous run to compare against (first backup)"
    }

    # ------------------------------------------------------------------------------- encryption
    Write-Log "==> Encrypting to $RecipientKey"
    $gpgRun = Invoke-Bounded -FilePath $gpgExe -Arguments @(
        "--batch", "--yes", "--trust-model", "always",
        "--recipient", $RecipientKey,
        "--output", $encArchive,
        "--encrypt", $plainArchive
    ) -Timeout 900
    if ($gpgRun.ExitCode -ne 0) { throw "gpg encryption failed: $($gpgRun.StdErr)" }
    if (-not (Test-Path -LiteralPath $encArchive)) { throw "gpg reported success but no encrypted archive exists" }

    $encSize = (Get-Item -LiteralPath $encArchive).Length
    Write-Log "encrypted     : $encArchive ($encSize bytes)"

    # The plaintext dump must not survive the run.
    Remove-Item -LiteralPath $plainArchive -Force
    Write-Log "plaintext     : removed"

    # --------------------------------------------------------------------------------- manifest
    # Pulled out of the hashtable literal because mongodump writes its banner to stderr and the
    # match can come back as an array; indexing an @() wrapper is the only form that is safe whether
    # it matched zero, one or several lines.
    $versionLines = @($dumpRun.StdErr -split "`r?`n" | Where-Object { $_ -match 'mongodump version' })
    $mongodumpVersion = if ($versionLines.Count -gt 0) {
        ([string]$versionLines[0] -replace '.*mongodump version:\s*', '').Trim()
    } else { "unknown" }

    $manifest = [ordered]@{
        createdUtc         = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        database           = $dbName
        mongodumpVersion   = $mongodumpVersion
        archiveEncrypted   = Split-Path -Leaf $encArchive
        archiveBytesPlain  = $plainSize
        archiveBytesCipher = $encSize
        recipient          = $RecipientKey
        collectionCount    = $collectionCount
        counts             = $counts
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Log "manifest      : $manifestPath"

    # ------------------------------------------------------------------------------- off-host
    if ($WhatIfNoUpload) {
        Write-Log "off-host      : SKIPPED (-WhatIfNoUpload)"
    } elseif ([string]::IsNullOrWhiteSpace($OffHostDirectory)) {
        Write-Log "off-host      : *** NOT CONFIGURED *** -- this archive is on the same machine that"
        Write-Log "                produced it, so it does not survive losing that machine. Pass"
        Write-Log "                -OffHostDirectory once O3 chooses a destination."
    } else {
        if (-not (Test-Path -LiteralPath $OffHostDirectory)) {
            New-Item -ItemType Directory -Force -Path $OffHostDirectory | Out-Null
        }
        Copy-Item -LiteralPath $encArchive -Destination $OffHostDirectory -Force
        Copy-Item -LiteralPath $manifestPath -Destination $OffHostDirectory -Force
        $remoteCopy = Join-Path $OffHostDirectory (Split-Path -Leaf $encArchive)
        if (-not (Test-Path -LiteralPath $remoteCopy)) { throw "off-host copy did not appear at $remoteCopy" }
        if ((Get-Item -LiteralPath $remoteCopy).Length -ne $encSize) { throw "off-host copy size does not match the local archive" }
        Write-Log "off-host      : $remoteCopy"
    }

    # ---------------------------------------------------------------------------------- prune
    if ($Retain -lt 1) { throw "-Retain must be at least 1" }
    foreach ($dir in @($OutputDirectory, $OffHostDirectory)) {
        if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { continue }
        $archives = @(Get-ChildItem -LiteralPath $dir -Filter "*.archive.gz.gpg" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending)
        if ($archives.Count -le $Retain) {
            Write-Log ("retained      : {0} archive(s) in {1}, none pruned (limit {2})" -f $archives.Count, $dir, $Retain)
            continue
        }
        foreach ($old in ($archives | Select-Object -Skip $Retain)) {
            $mate = $old.FullName -replace '\.archive\.gz\.gpg$', '.manifest.json'
            Remove-Item -LiteralPath $old.FullName -Force
            if (Test-Path -LiteralPath $mate) { Remove-Item -LiteralPath $mate -Force }
            Write-Log ("pruned        : {0}" -f $old.Name)
        }
    }

    Write-Log "==> Backup complete"
    Write-Log "NOTE: an untested backup is not a backup. Run tools\restore-drill.ps1 against this archive."
    $exit = 0
}
catch {
    Write-Log "FAILED        : $($_.Exception.Message)"
    $exit = 1
}
finally {
    if (Test-Path -LiteralPath $configFile) { Remove-Item -LiteralPath $configFile -Force }
    try {
        $dockerExe = (Get-Command docker -ErrorAction SilentlyContinue)
        if ($dockerExe) {
            Invoke-Bounded -FilePath $dockerExe.Source -Arguments @("exec", $MongoToolContainer, "rm", "-f", $containerConfig, $containerArchive) -Timeout 60 | Out-Null
        }
    } catch { }
    if (Test-Path -LiteralPath $plainArchive) {
        Remove-Item -LiteralPath $plainArchive -Force
        Write-Log "cleanup       : removed a leftover plaintext archive"
    }
    Write-LogAtomically $LogPath
}

exit $exit
