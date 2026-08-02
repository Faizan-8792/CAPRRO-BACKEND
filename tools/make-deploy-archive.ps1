# Builds a Hostinger deployment archive for capro-backend.
#
# Hostinger deploys from an uploaded archive, not from git, so a push alone never changes
# the live API. The build step on the server runs the install, so node_modules is excluded
# deliberately rather than by oversight.
#
# Secrets must never enter the archive. Environment values live in Hostinger environment
# variables. This script refuses to produce an archive if any .env file slipped in.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-deploy-archive.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend",
    [string]$OutputDirectory = "D:\CA-PRO-Toolkit"
)

$ErrorActionPreference = "Stop"

$excludedDirectories = @(".git", "node_modules", "dist", ".codescout", "coverage", "tools")
$excludedFilePatterns = @("^\.env", "\.log$", "\.zip$")

$stamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
$archivePath = Join-Path $OutputDirectory "capro-backend_$stamp.zip"
$stagingPath = Join-Path $env:TEMP "capro-backend-stage-$stamp"

if (Test-Path $stagingPath) { Remove-Item $stagingPath -Recurse -Force }
New-Item -ItemType Directory -Path $stagingPath | Out-Null

$rootLength = (Resolve-Path $RepoRoot).Path.Length + 1
$copied = 0
$staged = New-Object System.Collections.Generic.List[object]

Get-ChildItem -Path $RepoRoot -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($rootLength)
    $segments = $relative -split "\\"

    foreach ($segment in $segments[0..($segments.Length - 2)]) {
        if ($excludedDirectories -contains $segment) { return }
    }

    foreach ($pattern in $excludedFilePatterns) {
        if ($_.Name -match $pattern) { return }
    }

    $destination = Join-Path $stagingPath $relative
    $destinationDirectory = Split-Path $destination -Parent
    if (-not (Test-Path $destinationDirectory)) {
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    }

    Copy-Item -LiteralPath $_.FullName -Destination $destination
    $script:copied++

    # The relative path is recorded here rather than recomputed from the staging root later.
    # $env:TEMP can resolve to an 8.3 short path while Get-ChildItem returns the long form,
    # and the resulting substring offset silently truncates every entry name in the archive.
    $staged.Add([pscustomobject]@{ Source = $destination; Entry = $relative.Replace("\", "/") })
}

# Refuse rather than warn. A secret in a deployment archive is not recoverable by deleting
# the archive afterwards.
$leakedSecrets = Get-ChildItem -Path $stagingPath -Recurse -Force -File |
    Where-Object { $_.Name -like ".env*" -or $_.Name -like "*.pfx" -or $_.Name -like "*.pem" }

if ($leakedSecrets) {
    Remove-Item $stagingPath -Recurse -Force
    Write-Output "REFUSED: secret-bearing files were staged:"
    $leakedSecrets | ForEach-Object { Write-Output ("  " + $_.Name) }
    exit 1
}

foreach ($required in @("package.json", "src\server.js")) {
    if (-not (Test-Path (Join-Path $stagingPath $required))) {
        Remove-Item $stagingPath -Recurse -Force
        Write-Output "REFUSED: archive is missing $required, deploying it would take the API down"
        exit 1
    }
}

if (Test-Path $archivePath) { Remove-Item $archivePath -Force }

# Compress-Archive on Windows PowerShell 5.1 writes entry names with a backslash separator.
# The ZIP spec requires "/", and the Hostinger host is Linux: a backslash entry extracts as a
# single flat file literally named "src\server.js", so the entry point would be missing and
# the API would fail to boot. Build the entries by hand with forward slashes instead.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Enum arguments are passed as strings so this file still parses on a host where the
# compression assemblies are not loaded at parse time.
$archiveStream = [System.IO.Compression.ZipFile]::Open($archivePath, "Create")
try {
    foreach ($item in $staged) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archiveStream, $item.Source, $item.Entry, "Optimal")
    }
}
finally {
    $archiveStream.Dispose()
}

Remove-Item $stagingPath -Recurse -Force

$archive = Get-Item $archivePath
Write-Output ("files staged : " + $copied)
Write-Output ("archive      : " + $archive.FullName)
Write-Output ("size         : " + [math]::Round($archive.Length / 1MB, 2) + " MB")
Write-Output ("sha256       : " + (Get-FileHash $archivePath -Algorithm SHA256).Hash)
