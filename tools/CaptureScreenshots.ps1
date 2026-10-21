# CaptureScreenshots.ps1
#
# Regenerates the screenshots used by README.md. Runs the editor in a headless
# browser at a fixed window size and writes PNGs into docs\shots\.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\CaptureScreenshots.ps1
#
# Notes:
# - Uses Chrome or Edge in headless mode. Both support --screenshot and
#   --window-size, which is all this needs.
# - The page is served over http from a temporary Python server, because the
#   editor loads native ES modules, which browsers refuse over file://.
# - No third-party tooling is required.

[CmdletBinding()]
param(
  [int]$Width = 1440,
  [int]$Height = 900,
  [int]$Port = 8791
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$shotDir = Join-Path $root 'docs\shots'

# --- find a browser -------------------------------------------------------
$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
  throw "No Chrome or Edge found. Install either one, or capture the screenshots by hand."
}
Write-Host "Browser: $browser"

# --- find python ----------------------------------------------------------
$python = $null
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py) { $python = $py.Source }
if (-not $python -and (Test-Path 'C:\Users\spars\AppData\Local\Programs\Python\Python312\python.exe')) {
  $python = 'C:\Users\spars\AppData\Local\Programs\Python\Python312\python.exe'
}
if (-not $python) {
  throw "Python not found, and it is needed to serve the page over http. Install Python, or capture the screenshots by hand."
}

if (-not (Test-Path $shotDir)) { New-Item -ItemType Directory -Path $shotDir -Force | Out-Null }

# --- serve the project root ----------------------------------------------
Write-Host "Serving $root on port $Port ..."
$server = Start-Process -FilePath $python -PassThru -WindowStyle Hidden `
  -ArgumentList @('-m', 'http.server', "$Port", '--bind', '127.0.0.1') `
  -WorkingDirectory $root

try {
  # wait for the server to answer
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $null = Invoke-WebRequest "http://127.0.0.1:$Port/index.html" -UseBasicParsing -TimeoutSec 2
      $ready = $true; break
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ready) { throw "The local server never came up on port $Port." }

  # --- capture ------------------------------------------------------------
  # The editor boots into its default layout. Headless Chrome can load the page
  # and screenshot it, but it cannot be scripted to open individual panels and
  # then be screenshotted in the same pass, so this captures the default view.
  # For per-panel shots, open the editor and capture them by hand.
  $shots = @(
    @{ name = 'editor'; query = '?shot=editor' }
  )

  $userData = Join-Path $env:TEMP ("openscene-shots-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

  foreach ($s in $shots) {
    $out = Join-Path $shotDir ($s.name + '.png')
    $url = "http://127.0.0.1:$Port/index.html$($s.query)"
    $args = @(
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--virtual-time-budget=15000',
      "--window-size=$Width,$Height",
      "--user-data-dir=$userData",
      "--screenshot=$out",
      $url
    )
    Write-Host "Capturing $($s.name) ..."
    & $browser @args | Out-Null
    if (Test-Path $out) {
      Write-Host "  wrote $out ($((Get-Item $out).Length) bytes)"
    } else {
      Write-Warning "  $($s.name) was not written."
    }
  }

  Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
}
finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "Done. Screenshots are in $shotDir"
Write-Host "If a shot is blank, open the editor and capture it by hand - headless timing varies by machine."
