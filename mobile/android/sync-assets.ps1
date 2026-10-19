# OpenScene - sync-assets.ps1
#
# Copies the single shared web app into the Android shell's assets so the phone
# runs exactly the same editor as the Windows build. Run this after any change
# under js/, css/, resources/ or icons/:
#
#   powershell -ExecutionPolicy Bypass -File .\sync-assets.ps1
#
# Then build with the no-Gradle script (downloads JDK 17 + Android SDK on first run):
#
#   powershell -ExecutionPolicy Bypass -File tools\Build-AndroidApp.ps1   # -> app\build\outputs\apk\debug\app-debug.apk

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$dest = Join-Path $here 'app\src\main\assets\www'

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Every path here is also in Build-WindowsApp.ps1: one app, every platform.
$entries = @(
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'LICENSE',
  'css',
  'js',
  'resources',
  'icons'
)

foreach ($e in $entries) {
  $src = Join-Path $root $e
  if (-not (Test-Path $src)) { Write-Warning "missing: $e"; continue }
  Copy-Item $src -Destination $dest -Recurse -Force
  Write-Host "  + $e"
}

# The mobile host bridge is injected by MainActivity before page scripts run.
Copy-Item (Join-Path $here '..\host-bridge-mobile.js') -Destination $dest -Force
Write-Host '  + host-bridge-mobile.js'

# Keep a second copy outside www so the bridge can always be loaded even if the
# asset tree is trimmed by an aggressive build config.
Copy-Item (Join-Path $here '..\host-bridge-mobile.js') -Destination (Join-Path $here 'app\src\main\assets\host-bridge-mobile.js') -Force

$count = (Get-ChildItem -Recurse -File $dest | Measure-Object).Count
Write-Host ""
Write-Host "Android assets synced: $count files -> $dest"
