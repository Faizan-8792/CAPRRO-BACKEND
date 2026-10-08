# Probes the live API and prints status code plus a body excerpt for each route.
#
# The Express app ends with an authenticated catch-all on /api, so a route that does not exist
# answers with the same 401 as a route that exists but rejects the caller. A single 401 proves
# nothing. Every run therefore probes a deliberately fake sibling path as a control.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe-live-api.ps1

[CmdletBinding()]
param(
    [string]$BaseUrl = "https://api.caprotoolkit.in",
    [int]$BodyExcerptLength = 700
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$paths = @(
    "/health",
    "/api/app-config",
    "/api/auth/terms/current",
    "/api/auth/definitely-not-a-real-route-xyz"
)

foreach ($path in $paths) {
    $url = $BaseUrl + $path
    $status = "no-response"
    $body = ""

    try {
        $response = Invoke-WebRequest -Uri $url -Method GET -UseBasicParsing -TimeoutSec 30
        $status = [int]$response.StatusCode
        $body = $response.Content
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Dispose()
        }
        else {
            $body = $_.Exception.Message
        }
    }
    catch {
        $body = $_.Exception.Message
    }

    $excerpt = $body -replace "\s+", " "
    if ($excerpt.Length -gt $BodyExcerptLength) {
        $excerpt = $excerpt.Substring(0, $BodyExcerptLength) + " ...[truncated]"
    }

    Write-Output ("PATH   : " + $path)
    Write-Output ("STATUS : " + $status)
    Write-Output ("BODY   : " + $excerpt)
    Write-Output ""
}
