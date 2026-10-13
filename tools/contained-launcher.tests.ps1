# tools/contained-launcher.tests.ps1
#
# Pins the stdin handshake of the contained-process launcher that run-gates.ps1 and
# make-deploy-archive.ps1 both embed.
#
# WHY THIS EXISTS
# ---------------
# Both scripts spawn every child through a nested Windows PowerShell that reads one authorization
# byte (67) from stdin before it will start anything. The parent writes that byte and nothing else -
# but Windows PowerShell builds the parent's StandardInput StreamWriter from [Console]::InputEncoding
# with AutoFlush on, and that flush emits the encoding's PREAMBLE into the pipe first. On a UTF-8
# console the preamble is EF BB BF, so a strict read of the first byte saw 239 and refused EVERY
# launch. Measured 2026-08-26: all 50 test suites, npm audit, the commit-pinned archive validation
# and 165 node --check calls all reported failure, with nothing wrong with any of them, and
# make-deploy-archive.ps1 could not build a deploy archive at all.
#
# The reason this needs a test rather than a comment is that the defect is invisible on a console
# whose input encoding has no preamble. It reappears the moment the operator's console differs from
# the developer's, which is exactly the condition a release gate must not be sensitive to.
#
# WHAT IS UNDER TEST
# ------------------
# The launcher source is extracted from BOTH scripts by AST, so the test also fails if the two copies
# drift apart. Each case feeds a hand-built stdin byte sequence, so the assertions do not depend on
# this console's encoding:
#
#   67                 bare handshake                 -> child runs
#   EF BB BF 67        UTF-8 preamble then handshake  -> child runs
#   FF FE 67           UTF-16LE preamble              -> child runs
#   FE FF 67           UTF-16BE preamble              -> child runs
#   65                 wrong byte                     -> refused  (negative control)
#   EF BB 67           truncated preamble             -> refused  (negative control)
#   (nothing)          closed stdin                   -> refused  (negative control)
#
# The negative controls are the point. Without them a launcher that skipped the handshake entirely
# would pass every positive case.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\contained-launcher.tests.ps1
# Exits 0 when every case passes, 1 otherwise. Prints one line per case.

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is empty inside a param() default under Windows PowerShell 5.1, so the repository
# root is resolved here instead of in the parameter declaration.
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

$scripts = @(
    (Join-Path $RepoRoot "tools\run-gates.ps1"),
    (Join-Path $RepoRoot "tools\make-deploy-archive.ps1")
)

$passed = 0
$failed = 0
$failures = New-Object System.Collections.Generic.List[string]

function Test-Case {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Detail
    )

    if ($Condition) {
        $script:passed++
        Write-Output ("  PASS " + $Id.PadRight(46) + $Detail)
    }
    else {
        $script:failed++
        $script:failures.Add($Id)
        Write-Output ("  FAIL " + $Id.PadRight(46) + $Detail)
    }
}

function Get-LauncherSource {
    param([Parameter(Mandatory = $true)][string]$Path)

    $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($Path))
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    if (@($errors).Count -gt 0) { throw "$Path does not parse: $(@($errors)[0].Message)" }
    $definition = $ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq "Get-ContainedProcessLauncherCommand"
        }, $true)
    if (@($definition).Count -ne 1) {
        throw "$Path does not define exactly one Get-ContainedProcessLauncherCommand"
    }
    $block = [scriptblock]::Create(@($definition)[0].Extent.Text + "`nGet-ContainedProcessLauncherCommand")
    return (& $block)
}

# Runs the launcher with an EXACT stdin byte sequence.
#
# Deliberately NOT via RedirectStandardInput: touching Process.StandardInput is what makes a parent
# emit its own encoding preamble, so a harness that wrote through it would prepend this console's
# preamble to whatever bytes the case specifies and could never test the bare-67 case at all - the
# first draft of this file did exactly that and reported four false failures. Instead the bytes go
# into a temp file and cmd.exe redirects it in, so the child's stdin is byte-for-byte the case.
function Invoke-Launcher {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherSource,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$StdinBytes,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $node = @(Get-Command node -CommandType Application -All -ErrorAction Stop)[0].Source
    $configuration = [ordered]@{
        filePath = [System.IO.Path]::GetFullPath($node)
        arguments = '-e "process.stdout.write(\"CONTAINED_OK\")"'
        workingDirectory = $WorkingDirectory
    } | ConvertTo-Json -Compress
    $encodedConfiguration = [Convert]::ToBase64String(
        [System.Text.UTF8Encoding]::new($false).GetBytes($configuration))
    $stem = Join-Path ([System.IO.Path]::GetTempPath()) ("capro-handshake-" + [Guid]::NewGuid().ToString("N"))
    $stdinPath = $stem + ".bin"
    [System.IO.File]::WriteAllBytes($stdinPath, $StdinBytes)
    # -File, not -EncodedCommand: cmd.exe caps its command line at 8191 characters and the base64 of
    # this launcher is well past that, which fails as "The command line is too long." before the
    # launcher ever runs. The source is pure ASCII, so a BOM-less file is read correctly by
    # Windows PowerShell's ANSI default as well as by a UTF-8 one.
    $launcherPath = $stem + ".ps1"
    [System.IO.File]::WriteAllText($launcherPath, $LauncherSource, [System.Text.UTF8Encoding]::new($false))

    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Join-Path $env:SystemRoot "System32\cmd.exe"
    # cmd /c wants the WHOLE command in one extra pair of quotes when any path inside is quoted:
    #   /c ""<exe>" <args> < "<file>""
    # Closing that extra quote early - after the arguments rather than after the redirect - makes cmd
    # exit 1 with no output at all, which is what the first draft of this harness did.
    $startInfo.Arguments = '/c ""' + $powershellPath +
        '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcherPath +
        '" < "' + $stdinPath + '""'
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.EnvironmentVariables["CAPRO_CONTAINED_PROCESS_CONFIG"] = $encodedConfiguration

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $outputStream = [System.IO.MemoryStream]::new()
    $errorStream = [System.IO.MemoryStream]::new()
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) { throw "unable to start the launcher under test" }
        $outputTask = $process.StandardOutput.BaseStream.CopyToAsync($outputStream)
        $errorTask = $process.StandardError.BaseStream.CopyToAsync($errorStream)
        if (-not $process.WaitForExit(60000)) {
            try { $process.Kill() } catch { }
            throw "the launcher under test did not exit within 60s"
        }
        [void]$outputTask.Wait(5000)
        [void]$errorTask.Wait(5000)
        $decoder = [System.Text.UTF8Encoding]::new($false)
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $decoder.GetString($outputStream.ToArray())
            StandardError = $decoder.GetString($errorStream.ToArray())
        }
    }
    finally {
        if ($started -and -not $process.HasExited) {
            try { $process.Kill() } catch { }
            try { [void]$process.WaitForExit(5000) } catch { }
        }
        $process.Dispose()
        $outputStream.Dispose()
        $errorStream.Dispose()
        try { Remove-Item -LiteralPath $stdinPath -Force -ErrorAction SilentlyContinue } catch { }
        try { Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue } catch { }
    }
}

Write-Output "contained launcher handshake"
Write-Output ("console input encoding: " + [Console]::InputEncoding.WebName +
    ", preamble bytes: " + [Console]::InputEncoding.GetPreamble().Length)
Write-Output ""

$sources = @{}
foreach ($path in $scripts) {
    $name = Split-Path -Leaf $path
    try {
        $sources[$name] = Get-LauncherSource -Path $path
        Test-Case -Id "$name launcher extracted" -Condition $true -Detail "$(($sources[$name] -split "`n").Count) lines"
    }
    catch {
        Test-Case -Id "$name launcher extracted" -Condition $false -Detail $_.Exception.Message
    }
}

# The two scripts each carry their own copy. They are supposed to be the same protocol, so a fix
# applied to one and not the other is itself a defect, and it has to fail here rather than in
# production.
if ($sources.Count -eq 2) {
    $values = @($sources.Values)
    Test-Case -Id "both scripts embed the same launcher" `
        -Condition ($values[0] -eq $values[1]) `
        -Detail "byte-compare of the two extracted here-strings"
}

$cases = @(
    @{ Id = "bare handshake 67";                    Bytes = [byte[]]@(67);                  Expect = $true },
    @{ Id = "UTF-8 preamble EF BB BF then 67";      Bytes = [byte[]]@(239, 187, 191, 67);   Expect = $true },
    @{ Id = "UTF-16LE preamble FF FE then 67";      Bytes = [byte[]]@(255, 254, 67);        Expect = $true },
    @{ Id = "UTF-16BE preamble FE FF then 67";      Bytes = [byte[]]@(254, 255, 67);        Expect = $true },
    @{ Id = "NEGATIVE wrong byte 65";               Bytes = [byte[]]@(65);                  Expect = $false },
    @{ Id = "NEGATIVE truncated preamble EF BB 67"; Bytes = [byte[]]@(239, 187, 67);        Expect = $false },
    @{ Id = "NEGATIVE closed stdin";                Bytes = [byte[]]@();                    Expect = $false }
)

foreach ($name in @($sources.Keys | Sort-Object)) {
    Write-Output ""
    Write-Output "  -- $name"
    foreach ($case in $cases) {
        try {
            $result = Invoke-Launcher -LauncherSource $sources[$name] `
                -StdinBytes $case.Bytes -WorkingDirectory $RepoRoot
            $ran = $result.ExitCode -eq 0 -and $result.StandardOutput.Contains("CONTAINED_OK")
            $refused = $result.ExitCode -ne 0 -and $result.StandardError.Contains("not authorized")
            if ($case.Expect) {
                $detail = "exit=$($result.ExitCode) stdout=$($result.StandardOutput.Trim())"
                if (-not $ran) {
                    $firstErrorLine = @($result.StandardError -split "`r?`n" |
                        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
                    $detail += " stderr=" + (($firstErrorLine -join " ").Trim())
                }
                Test-Case -Id "$name $($case.Id)" -Condition $ran -Detail $detail
            }
            else {
                Test-Case -Id "$name $($case.Id)" -Condition $refused `
                    -Detail "exit=$($result.ExitCode) refused=$refused"
            }
        }
        catch {
            Test-Case -Id "$name $($case.Id)" -Condition $false -Detail $_.Exception.Message
        }
    }
}

Write-Output ""
Write-Output "passed: $passed  failed: $failed"
if ($failed -gt 0) {
    Write-Output ("failing cases: " + ($failures -join ", "))
    exit 1
}
Write-Output "CONTAINED LAUNCHER HANDSHAKE OK"
exit 0
