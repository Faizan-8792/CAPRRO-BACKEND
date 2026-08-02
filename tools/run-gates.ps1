# Runs every backend gate and writes one plain-text summary.
# Exists because long inline PowerShell commands were being truncated by the console,
# which silently skipped steps and left a stale log behind.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-gates.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend",
    [string]$LogPath = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend\gates.log"
)

$ErrorActionPreference = "Continue"
Set-Location $RepoRoot
$report = New-Object System.Collections.Generic.List[string]
$failures = 0

$report.Add("backend gates")
$report.Add("generated: " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
$report.Add("")

# --- syntax check every source file, so a typo cannot reach a deploy ---
$report.Add("===== node --check =====")
$badSyntax = 0
Get-ChildItem -Path (Join-Path $RepoRoot "src") -Recurse -Filter *.js -File | ForEach-Object {
    $null = & node --check $_.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        $badSyntax++
        $report.Add("  SYNTAX FAIL " + $_.FullName.Substring($RepoRoot.Length + 1))
    }
}
$report.Add("  files with syntax errors: $badSyntax")
if ($badSyntax -gt 0) { $failures++ }

# --- test suites ---
$suites = @(
    "production-readiness-checklist",
    "desktop-token-route",
    "terms-acceptance-contract",
    "workspace-operation-contract",
    "firm-authorization-contract",
    "task-flow-checklist",
    "taxworker-flow-checklist"
)

$report.Add("")
$report.Add("===== test suites =====")
foreach ($suite in $suites) {
    $path = Join-Path $RepoRoot "tests\$suite.mjs"
    if (-not (Test-Path $path)) {
        $report.Add("  $suite : FILE MISSING")
        $failures++
        continue
    }

    $output = & node $path 2>&1 | Out-String
    $exit = $LASTEXITCODE

    # Suites print their own tally; capture the last line that carries one.
    $tally = ($output -split "`r?`n" |
        Where-Object { $_ -match "\d+\s*/\s*\d+|passed|failed|PASS|FAIL" } |
        Select-Object -Last 1)

    $report.Add("  " + $suite.PadRight(34) + " exit=$exit  " + ($tally -replace "\s+", " ").Trim())
    if ($exit -ne 0) { $failures++ }
}

# --- dependency audit ---
$report.Add("")
$report.Add("===== npm audit (prod, high) =====")
$audit = & npm audit --omit=dev --audit-level=high 2>&1 | Out-String
$auditExit = $LASTEXITCODE
$auditLine = ($audit -split "`r?`n" | Where-Object { $_ -match "vulnerabilit" } | Select-Object -Last 1)
$report.Add("  exit=$auditExit  " + ($auditLine -replace "\s+", " ").Trim())
if ($auditExit -ne 0) { $failures++ }

$report.Add("")
$report.Add("===== SUMMARY =====")
$report.Add("failing gates: $failures")
if ($failures -eq 0) {
    $report.Add("ALL GATES GREEN")
}
else {
    $report.Add("GATES FAILED - DO NOT DEPLOY")
}

Set-Content -LiteralPath $LogPath -Value ($report -join "`n") -Encoding UTF8
Write-Output "failing gates: $failures"
Write-Output "log written to $LogPath"
