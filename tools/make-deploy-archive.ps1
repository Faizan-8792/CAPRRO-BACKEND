# Builds a Hostinger deployment archive for capro-backend.
#
# Hostinger deploys from an uploaded archive, not from git, so a push alone never changes
# the live API. The server runs npm install during deployment, so node_modules is excluded.
#
# The archive is built from one resolved Git commit, never from mutable worktree bytes. Only
# package manifests and the src/public runtime trees are eligible. The script validates paths,
# required files, secret-bearing filenames, and obvious embedded credentials before atomically
# publishing the final ZIP.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-deploy-archive.ps1

[CmdletBinding()]
param(
    [string]$RepoRoot = "D:\CA-PRO-Toolkit\CA-PRO-Toolkit\capro-backend",
    [string]$OutputDirectory = "D:\CA-PRO-Toolkit"
)

$ErrorActionPreference = "Stop"

$allowedPaths = @("package.json", "package-lock.json", "src", "public")
$requiredEntries = @("package.json", "package-lock.json", "src/server.js")
$forbiddenPathPattern = '(?i)(^|/)(\.env(?:\..*)?|\.npmrc|[^/]*\.(?:pem|pfx|p12|key)|(?:credentials?|secrets?)(?:\.[^/]*)?)$'
$textFilePattern = '(?i)\.(?:css|html|js|json|md|mjs|txt|xml)$'
$secretContentPatterns = @(
    '(?i)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '(?i)mongodb(?:\+srv)?://[^/\s:]+:[^@\s]+@',
    '(?im)^\s*(?:MONGO_URI|MONGODB_URI|JWT_SECRET|GOOGLE_CLIENT_SECRET|RESEND_API_KEY)\s*=\s*[''"]?[^\s''"]{8,}',
    '(?i)"client_secret"\s*:\s*"(?!\s*(?:REPLACE_ME|YOUR_|CHANGEME))[^"]{8,}"'
)

if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    Write-Output "REFUSED: backend repository does not exist: $RepoRoot"
    exit 1
}
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    Write-Output "REFUSED: archive output directory does not exist: $OutputDirectory"
    exit 1
}

$trackedStatus = @(& git -C $RepoRoot status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) {
    Write-Output "REFUSED: unable to verify the backend git worktree"
    exit 1
}
if ($trackedStatus.Count -gt 0) {
    Write-Output "REFUSED: tracked backend files differ from HEAD; commit or restore them first"
    $trackedStatus | ForEach-Object { Write-Output ("  " + $_) }
    exit 1
}

$commit = (& git -C $RepoRoot rev-parse --verify "HEAD^{commit}" | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) {
    Write-Output "REFUSED: unable to resolve the backend HEAD commit"
    exit 1
}
$commit = $commit.Trim()

$stamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
$archiveName = "capro-backend_$stamp.zip"
$archivePath = Join-Path $OutputDirectory $archiveName
$temporaryArchivePath = Join-Path $OutputDirectory (".$archiveName.partial-" + $PID)
$fileCount = 0

if (Test-Path -LiteralPath $archivePath) {
    Write-Output "REFUSED: archive destination already exists: $archivePath"
    exit 1
}
if (Test-Path -LiteralPath $temporaryArchivePath) {
    Remove-Item -LiteralPath $temporaryArchivePath -Force
}

try {
    $archiveArguments = @(
        "archive",
        "--format=zip",
        "--output=$temporaryArchivePath",
        $commit,
        "--"
    ) + $allowedPaths
    & git -C $RepoRoot @archiveArguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryArchivePath -PathType Leaf)) {
        throw "git archive failed for commit $commit"
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($temporaryArchivePath)
    try {
        $fileEntries = New-Object System.Collections.Generic.List[object]
        foreach ($entry in $archive.Entries) {
            $entryPath = $entry.FullName
            if (
                [string]::IsNullOrWhiteSpace($entryPath) -or
                $entryPath.Contains("\") -or
                $entryPath.StartsWith("/") -or
                $entryPath -match "^[A-Za-z]:" -or
                @($entryPath -split "/" | Where-Object { $_ -eq ".." }).Count -gt 0
            ) {
                throw "archive contains an unsafe path: $entryPath"
            }

            $normalizedPath = $entryPath.TrimEnd("/")
            $isAllowed =
                $normalizedPath -eq "package.json" -or
                $normalizedPath -eq "package-lock.json" -or
                $normalizedPath -eq "src" -or
                $normalizedPath.StartsWith("src/") -or
                $normalizedPath -eq "public" -or
                $normalizedPath.StartsWith("public/")
            if (-not $isAllowed) {
                throw "archive contains a path outside the runtime allowlist: $entryPath"
            }

            if ([string]::IsNullOrEmpty($entry.Name)) { continue }
            if ($entryPath -match $forbiddenPathPattern) {
                throw "archive contains a forbidden secret-bearing filename: $entryPath"
            }
            $fileEntries.Add($entry)
        }

        $entryNames = @($fileEntries | ForEach-Object FullName)
        foreach ($required in $requiredEntries) {
            if ($entryNames -notcontains $required) {
                throw "archive is missing $required; deploying it would take the API down"
            }
        }

        foreach ($entry in $fileEntries) {
            if ($entry.FullName -notmatch $textFilePattern) { continue }
            $reader = [System.IO.StreamReader]::new($entry.Open())
            try {
                $content = $reader.ReadToEnd()
            }
            finally {
                $reader.Dispose()
            }
            foreach ($pattern in $secretContentPatterns) {
                if ($content -match $pattern) {
                    throw "archive content matched a secret pattern: $($entry.FullName)"
                }
            }
        }

        $fileCount = $fileEntries.Count
    }
    finally {
        $archive.Dispose()
    }

    Move-Item -LiteralPath $temporaryArchivePath -Destination $archivePath
}
catch {
    Write-Output ("REFUSED: " + $_.Exception.Message)
    exit 1
}
finally {
    if (Test-Path -LiteralPath $temporaryArchivePath) {
        Remove-Item -LiteralPath $temporaryArchivePath -Force
    }
}

$archiveFile = Get-Item -LiteralPath $archivePath
Write-Output ("commit        : " + $commit)
Write-Output ("files archived: " + $fileCount)
Write-Output ("archive       : " + $archiveFile.FullName)
Write-Output ("size          : " + [math]::Round($archiveFile.Length / 1MB, 2) + " MB")
Write-Output ("sha256        : " + (Get-FileHash $archivePath -Algorithm SHA256).Hash)
