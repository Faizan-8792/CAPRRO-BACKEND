# Restore drill for capro-backend backups (.kiro/finalreleasefix.md O4).
#
# An untested backup is not a backup. This decrypts an archive produced by tools\backup-database.ps1,
# restores it into a THROWAWAY scratch database, compares every collection's document count against
# the manifest captured at dump time, optionally proves the app itself can serve the restored data,
# and then drops the scratch database.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-drill.ps1 `
#       -ArchivePath D:\CA-PRO-Toolkit\capro-backups\capro-capro-20260823-120000.archive.gz.gpg `
#       -ScratchUri "mongodb://127.0.0.1:27017/scratch-drill"
#
# THE SCRATCH GUARD IS THE POINT OF THIS FILE. mongorestore --drop against the wrong URI destroys a
# live database, and the difference between the right URI and the wrong one is a few characters in
# a string a tired person pasted at 2am. This script refuses to run unless the database name in
# -ScratchUri starts with 'scratch-', and it checks that BEFORE it decrypts anything or starts
# mongorestore. A drill that can hit production is more dangerous than having no drill.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$ScratchUri,

    # Defaults to <archive minus .archive.gz.gpg>.manifest.json beside the archive.
    [string]$ManifestPath = "",

    [string]$MongoToolContainer = "capro-mongo-dev",

    # Step 8: start a backend against the restored data and GET /health. Off by default because it
    # needs node and a free port; the count comparison is the gate that always runs.
    [switch]$IncludeHealthCheck,

    [int]$HealthPort = 4599,

    # The health check runs the backend ON THE HOST, but the mongo tools may be running INSIDE a
    # container, and those two see the database at different addresses. The local dev container
    # publishes 27017 as 27117, so the tools use mongodb://127.0.0.1:27017/... while the host
    # backend must use mongodb://127.0.0.1:27117/... . Getting this wrong does not error - the
    # backend simply reports db.state "connecting" forever and the drill times out looking healthy-
    # ish. Defaults to -ScratchUri, which is correct whenever the tools are native rather than
    # containerised.
    [string]$HealthUri = "",

    [string]$RepoRoot = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend",

    [int]$TimeoutSeconds = 1800,

    [string]$GpgPath = "",

    # Leave the scratch database in place for inspection instead of dropping it.
    [switch]$KeepScratch
)

$ErrorActionPreference = "Stop"

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
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$Timeout = 600
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-Arg $_ }) -join ' ')
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $so = $proc.StandardOutput.ReadToEndAsync()
    $se = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($Timeout * 1000)) {
        try { $proc.Kill() } catch { }
        throw "TIMEOUT after ${Timeout}s: $FilePath"
    }
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; StdOut = $so.Result; StdErr = $se.Result }
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
    $native = Get-Command $Tool -ErrorAction SilentlyContinue
    if ($native) { return [pscustomobject]@{ FilePath = $native.Source; Prefix = @(); InContainer = $false } }
    $docker = Get-Command "docker" -ErrorAction SilentlyContinue
    if (-not $docker) { throw "$Tool is not on PATH and docker is not available." }
    $probe = Invoke-Bounded -FilePath $docker.Source -Arguments @("exec", $MongoToolContainer, "which", $Tool) -Timeout 60
    if ($probe.ExitCode -ne 0) { throw "$Tool is not on PATH and not inside container '$MongoToolContainer'." }
    return [pscustomobject]@{ FilePath = $docker.Source; Prefix = @("exec", "-i", $MongoToolContainer); InContainer = $true }
}

function Remove-DatabaseFromUri([string]$Uri) {
    <#
      mongorestore treats a database named in the connection string as an implicit --db, and that
      SILENTLY defeats --nsFrom/--nsTo: the restore is scoped to a database the archive contains no
      namespaces for, so it exits 0 having written nothing. Reproduced directly -- with the db in
      the URI, "0 document(s) restored successfully"; with it stripped, 86 documents and all 39
      collections. The db name is still needed for the scratch- guard and for the count query, so it
      is kept in -ScratchUri and removed only here, on the way into mongorestore.
    #>
    if ($Uri -match '^(?<head>mongodb(\+srv)?://[^/]+)(/(?<db>[^?]*))?(?<query>\?.*)?$') {
        $head = $Matches['head']
        $query = $Matches['query']
        if ($query) { return "$head/$query" }
        return $head
    }
    return $Uri
}

function Get-DatabaseNameFromUri([string]$Uri) {
    $noScheme = $Uri -replace '^mongodb(\+srv)?://', ''
    $slash = $noScheme.IndexOf('/')
    if ($slash -lt 0) { return "" }
    return (($noScheme.Substring($slash + 1)) -split '\?')[0]
}

# ============================================================ THE GUARD, BEFORE ANYTHING ELSE

$scratchDb = Get-DatabaseNameFromUri $ScratchUri
Write-Output "==> Restore drill"
Write-Output "scratch db    : $scratchDb"

if ([string]::IsNullOrWhiteSpace($scratchDb)) {
    # Write-Output, not Write-Error: with $ErrorActionPreference = 'Stop' a Write-Error is a
    # terminating error, so the script would die with exit 1 before reaching `exit 2` and the
    # caller could not tell a SAFETY REFUSAL (2) from a FAILED DRILL (1).
    Write-Output "REFUSING: -ScratchUri has no database name. It must name a database beginning with 'scratch-'."
    exit 2
}
if (-not $scratchDb.StartsWith("scratch-", [System.StringComparison]::Ordinal)) {
    Write-Output @"
REFUSING TO RUN. The database named in -ScratchUri is '$scratchDb', which does not begin with
'scratch-'. This drill runs mongorestore --drop, which deletes every collection it restores over.
Nothing has been decrypted and mongorestore has NOT been called.

If you meant to restore into a throwaway database, rename it, e.g.
  mongodb://127.0.0.1:27017/scratch-$scratchDb
"@
    exit 2
}

if (-not (Test-Path -LiteralPath $ArchivePath)) { throw "No archive at $ArchivePath" }

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = $ArchivePath -replace '\.archive\.gz\.gpg$', '.manifest.json'
}
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "No manifest at $ManifestPath. Without it there is nothing to compare the restored counts against, and a drill that checks nothing is theatre."
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$sourceDb = $manifest.database
Write-Output "source db     : $sourceDb"
Write-Output "archive       : $(Split-Path -Leaf $ArchivePath)"
Write-Output "dumped at     : $($manifest.createdUtc)"

$plain = Join-Path ([System.IO.Path]::GetTempPath()) ("capro-drill-" + [System.Guid]::NewGuid().ToString("N") + ".archive.gz")
$containerArchive = "/tmp/" + (Split-Path -Leaf $plain)
$exit = 0
$node = $null
$nodeLog = $null

try {
    # ------------------------------------------------------------------------------- decrypt
    Write-Output "==> Decrypting"
    $gpgExe = Resolve-Gpg $GpgPath
    Write-Output "gpg           : $gpgExe"
    $dec = Invoke-Bounded -FilePath $gpgExe -Arguments @("--batch", "--yes", "--output", $plain, "--decrypt", $ArchivePath) -Timeout 900
    if ($dec.ExitCode -ne 0) { throw "gpg decryption failed: $($dec.StdErr)" }
    $plainSize = (Get-Item -LiteralPath $plain).Length
    Write-Output "decrypted     : $plainSize bytes"
    if ([int64]$manifest.archiveBytesPlain -ne $plainSize) {
        throw "Decrypted size $plainSize does not match the manifest's $($manifest.archiveBytesPlain). The archive is not the one this manifest describes."
    }

    # ------------------------------------------------------------------------------- restore
    $restore = Get-MongoToolInvocation "mongorestore"
    if ($restore.InContainer) {
        $cp = Invoke-Bounded -FilePath $restore.FilePath -Arguments @("cp", $plain, "${MongoToolContainer}:$containerArchive") -Timeout 600
        if ($cp.ExitCode -ne 0) { throw "docker cp of the archive failed: $($cp.StdErr)" }
    }

    Write-Output "==> Restoring into $scratchDb"
    $rArgs = @()
    $rArgs += $restore.Prefix
    $restoreUri = Remove-DatabaseFromUri $ScratchUri
    Write-Output "restore uri   : $restoreUri (database stripped; nsTo governs the target)"
    $inner = @(
        "--uri=$restoreUri",
        "--gzip",
        "--archive=$(if ($restore.InContainer) { $containerArchive } else { $plain })",
        "--nsFrom=$sourceDb.*",
        "--nsTo=$scratchDb.*",
        "--drop"
    )
    if ($restore.InContainer) { $rArgs += @("mongorestore") + $inner } else { $rArgs += $inner }

    $rRun = Invoke-Bounded -FilePath $restore.FilePath -Arguments $rArgs -Timeout $TimeoutSeconds
    if ($rRun.ExitCode -ne 0) { throw "mongorestore failed (exit $($rRun.ExitCode)): $($rRun.StdErr)" }
    Write-Output "restored      : ok"

    # ------------------------------------------------------------------- count comparison table
    Write-Output "==> Comparing document counts against the manifest"
    $shell = Get-MongoToolInvocation "mongosh"
    $script = 'const out={};db.getCollectionNames().sort().forEach(function(c){out[c]=db.getCollection(c).countDocuments({});});print(JSON.stringify(out));'
    $sArgs = @()
    $sArgs += $shell.Prefix
    if ($shell.InContainer) { $sArgs += @("mongosh", $ScratchUri, "--quiet", "--eval", $script) }
    else { $sArgs += @($ScratchUri, "--quiet", "--eval", $script) }
    $sRun = Invoke-Bounded -FilePath $shell.FilePath -Arguments $sArgs -Timeout 600
    if ($sRun.ExitCode -ne 0) { throw "could not count the restored collections: $($sRun.StdErr)" }
    $line = ($sRun.StdOut -split "`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if (-not $line) { throw "mongosh returned no JSON payload. Raw: $($sRun.StdOut)" }
    $actual = $line | ConvertFrom-Json

    $expectedProps = @($manifest.counts.PSObject.Properties)
    $actualNames = @($actual.PSObject.Properties.Name)
    $names = @($expectedProps.Name) + $actualNames | Sort-Object -Unique

    $fail = 0
    Write-Output ""
    Write-Output ("{0,-34} {1,10} {2,10}  {3}" -f "COLLECTION", "EXPECTED", "ACTUAL", "RESULT")
    Write-Output ("-" * 72)
    foreach ($n in $names) {
        $e = if ($manifest.counts.PSObject.Properties.Name -contains $n) { [int64]$manifest.counts.$n } else { -1 }
        $a = if ($actualNames -contains $n) { [int64]$actual.$n } else { -1 }
        $ok = ($e -eq $a)
        if (-not $ok) { $fail++ }
        $eText = if ($e -lt 0) { "absent" } else { "$e" }
        $aText = if ($a -lt 0) { "absent" } else { "$a" }
        Write-Output ("{0,-34} {1,10} {2,10}  {3}" -f $n, $eText, $aText, $(if ($ok) { "PASS" } else { "FAIL" }))
    }
    Write-Output ("-" * 72)
    Write-Output ("collections compared : {0}" -f $names.Count)
    Write-Output ("mismatches           : {0}" -f $fail)

    if ($fail -gt 0) {
        throw "$fail collection(s) did not match the manifest. This restore is NOT proven."
    }

    # ------------------------------------------------------------------ app-level health (step 8)
    if ($IncludeHealthCheck) {
        Write-Output "==> Starting a backend against the restored data"
        $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
        if (-not $nodeCmd) { throw "node is not on PATH, so the health check cannot run. Re-run without -IncludeHealthCheck to skip it." }
        $env:NODE_ENV = "development"
        $effectiveHealthUri = if ($HealthUri) { $HealthUri } else { $ScratchUri }
        Write-Output "health uri    : $effectiveHealthUri"
        $env:MONGODB_URI = $effectiveHealthUri
        $env:PORT = "$HealthPort"

        # Fail fast and say WHY if the port is taken. A previous run that leaked its backend leaves
        # the port listening, the new backend cannot bind, and the drill then reports the useless
        # "never answered GET /health" - which reads like a restore problem when it is a stale
        # process. This check turns twenty minutes of confusion into one line.
        $inUse = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $_.Port -eq $HealthPort })
        if ($inUse.Count -gt 0) {
            throw "Port $HealthPort is already in use, so the health backend cannot bind. Something (probably a leaked backend from an earlier drill) is listening there. Free it or pass -HealthPort."
        }

        $nodeLog = Join-Path ([System.IO.Path]::GetTempPath()) ("capro-drill-health-" + [System.Guid]::NewGuid().ToString("N") + ".log")
        $node = Start-Process -FilePath $nodeCmd.Source -ArgumentList @("src/server.js") -WorkingDirectory $RepoRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $nodeLog -RedirectStandardError "$nodeLog.err"
        $ok = $false
        # 503 "degraded" while Mongo is still connecting is EXPECTED and answers instantly, so the
        # sleep has to be unconditional or the loop burns all its attempts in a couple of seconds.
        for ($i = 0; $i -lt 45; $i++) {
            Start-Sleep -Seconds 2
            try {
                $r = Invoke-WebRequest -Uri "http://127.0.0.1:$HealthPort/health" -UseBasicParsing -TimeoutSec 5
                if ($r.StatusCode -eq 200) {
                    Write-Output "health        : 200"
                    Write-Output "health body   : $($r.Content)"
                    $ok = $true
                    break
                }
            } catch { }
        }
        if (-not $ok) {
            $tail = ""
            foreach ($f in @($nodeLog, "$nodeLog.err")) {
                if (Test-Path -LiteralPath $f) {
                    $t = (Get-Content -LiteralPath $f -Tail 12 -ErrorAction SilentlyContinue) -join "`n"
                    if ($t) { $tail += "`n--- $(Split-Path -Leaf $f) ---`n$t" }
                }
            }
            throw ("the backend never answered GET /health 200 against the restored database." + $tail)
        }
    } else {
        Write-Output "health check  : skipped (pass -IncludeHealthCheck to run step 8)"
    }

    Write-Output ""
    Write-Output "==> DRILL PASSED"
    Write-Output "Re-run this drill after any change to the model set in capro-backend/src/models/."
}
catch {
    Write-Output "==> DRILL FAILED: $($_.Exception.Message)"
    $exit = 1
}
finally {
    if ($node -and -not $node.HasExited) { try { $node.Kill() } catch { } }
    if ($nodeLog) {
        foreach ($f in @($nodeLog, "$nodeLog.err")) {
            if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
        }
    }
    if (Test-Path -LiteralPath $plain) { Remove-Item -LiteralPath $plain -Force }
    try {
        $docker = Get-Command docker -ErrorAction SilentlyContinue
        if ($docker) { Invoke-Bounded -FilePath $docker.Source -Arguments @("exec", $MongoToolContainer, "rm", "-f", $containerArchive) -Timeout 60 | Out-Null }
    } catch { }

    if (-not $KeepScratch -and $scratchDb -and $scratchDb.StartsWith("scratch-", [System.StringComparison]::Ordinal)) {
        try {
            $shell2 = Get-MongoToolInvocation "mongosh"
            $dArgs = @()
            $dArgs += $shell2.Prefix
            if ($shell2.InContainer) { $dArgs += @("mongosh", $ScratchUri, "--quiet", "--eval", "db.dropDatabase()") }
            else { $dArgs += @($ScratchUri, "--quiet", "--eval", "db.dropDatabase()") }
            Invoke-Bounded -FilePath $shell2.FilePath -Arguments $dArgs -Timeout 120 | Out-Null
            Write-Output "scratch       : dropped"
        } catch {
            Write-Output "scratch       : could not be dropped ($($_.Exception.Message)). Drop '$scratchDb' by hand."
        }
    }
}

exit $exit
