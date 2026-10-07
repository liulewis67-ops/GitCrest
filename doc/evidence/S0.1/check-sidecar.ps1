$ErrorActionPreference = "Stop"

$sidecarPath = Join-Path $PSScriptRoot "..\..\..\crates\gitcrest-core\target\debug\gitcrest-core.exe"
$sidecarPath = [System.IO.Path]::GetFullPath($sidecarPath)
if (-not (Test-Path -LiteralPath $sidecarPath)) {
  throw "Build the debug sidecar first: $sidecarPath"
}

$tokenBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$token = [Convert]::ToBase64String($tokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $sidecarPath
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Environment["GITCREST_HOST"] = "127.0.0.1"
$startInfo.Environment["GITCREST_PORT"] = "0"
$startInfo.Environment["GITCREST_AUTH_TOKEN"] = $token

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) {
  throw "Could not start sidecar: $sidecarPath"
}

try {
  $readyLine = $process.StandardOutput.ReadLine()
  if (-not $readyLine) {
    throw "Sidecar exited without a ready message. $($process.StandardError.ReadToEnd())"
  }

  $ready = $readyLine | ConvertFrom-Json
  if ($ready.event -ne "ready" -or $ready.host -ne "127.0.0.1" -or $ready.port -le 0 -or $ready.port -gt 65535) {
    throw "Invalid sidecar ready message: $readyLine"
  }

  $baseUrl = "http://127.0.0.1:$($ready.port)"
  $health = Invoke-WebRequest "$baseUrl/health" -SkipHttpErrorCheck
  $unauthorized = Invoke-WebRequest "$baseUrl/api/version" -SkipHttpErrorCheck
  $authorized = Invoke-WebRequest "$baseUrl/api/version" -Headers @{ Authorization = "Bearer $token" }
  $version = $authorized.Content | ConvertFrom-Json

  if ($health.StatusCode -ne 204) { throw "Expected /health 204, got $($health.StatusCode)" }
  if ($unauthorized.StatusCode -ne 401) { throw "Expected unauthenticated /api/version 401, got $($unauthorized.StatusCode)" }
  if ($authorized.StatusCode -ne 200 -or $version.name -ne "gitcrest-core") {
    throw "Authenticated /api/version returned an unexpected response: $($authorized.Content)"
  }

  "PASS ready host is 127.0.0.1 on an ephemeral port"
  "PASS /health returned 204"
  "PASS unauthenticated /api/version returned 401"
  "PASS authenticated /api/version returned 200 ($($version.name) $($version.version))"
} finally {
  if (-not $process.HasExited) {
    $process.Kill()
    $process.WaitForExit(5000) | Out-Null
  }
  "sidecar exited after test cleanup: $($process.HasExited)"
}
