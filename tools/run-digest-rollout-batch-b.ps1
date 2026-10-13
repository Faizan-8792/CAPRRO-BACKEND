# One-time scheduled sender for the second half of the daily-digest notice.
# The Node runner loads secrets from capro-backend/.env; no credential is
# placed in the Windows task definition.
$ErrorActionPreference = "Stop"
$backendDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $backendDirectory
& node tools/digest-resource-rollout.mjs --send B
exit $LASTEXITCODE
