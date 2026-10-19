<#
  Build-AllPlatforms.ps1 - one shared editor, three per-OS folders in Downloads.

  OpenScene is a single web app with three thin native shells. This script builds
  everything that can be built on Windows and *publishes* the result into a
  separate, self-contained folder per target OS, so each one can be copied to the
  machine that finishes it:

    %USERPROFILE%\Downloads\OpenScene-Windows\   ready to run   (OpenScene.exe + editor)
    %USERPROFILE%\Downloads\OpenScene-Android\   Android Studio project, web app synced in
    %USERPROFILE%\Downloads\OpenScene-iOS\       Xcode sources,       web app synced in

  The source tree itself is never moved: this only writes to Downloads.

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\Build-AllPlatforms.ps1
    powershell -ExecutionPolicy Bypass -File tools\Build-AllPlatforms.ps1 -WebOnly
    powershell -ExecutionPolicy Bypass -File tools\Build-AllPlatforms.ps1 -SkipWindows
#>
[CmdletBinding()]
param(
  [switch]$WebOnly,        # refresh the editor files only; keep the existing .exe
  [switch]$SkipWindows,
  [switch]$SkipAndroid,
  [switch]$SkipIOS,
  [switch]$NoDist          # do not refresh the in-tree Dist\ portable zip
)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$downloads = Join-Path $env:USERPROFILE 'Downloads'

$winDest = Join-Path $downloads 'OpenScene-Windows'
$andDest = Join-Path $downloads 'OpenScene-Android'
$iosDest = Join-Path $downloads 'OpenScene-iOS'

# The files that make up the editor itself. Identical on every platform.
$web = @('index.html', 'manifest.webmanifest', 'sw.js', 'LICENSE', 'css', 'js', 'resources', 'icons')

function Step($m) { Write-Host "  $m" }
function Head($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }

function Copy-WebApp([string]$dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  foreach ($e in $web) {
    $src = Join-Path $root $e
    if (-not (Test-Path -LiteralPath $src)) { Write-Warning "  missing: $e"; continue }
    $target = Join-Path $dest $e
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force
  }
  foreach ($doc in @('README.md', 'CHANGELOG.md')) {
    $src = Join-Path $root $doc
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dest -Force }
  }
  # The bridge that supplies real file dialogs on a phone. Inert on desktop.
  $bridge = Join-Path $root 'mobile\host-bridge-mobile.js'
  if (Test-Path -LiteralPath $bridge) { Copy-Item -LiteralPath $bridge -Destination $dest -Force }

  # Give the published service worker a unique shell-cache name per publish, so a
  # browser holding an older copy of the app drops it on the next visit instead of
  # serving stale JavaScript forever. Only the *copy* is rewritten here.
  $swPath = Join-Path $dest 'sw.js'
  if (Test-Path -LiteralPath $swPath) {
    $stampId = (Get-Date).ToString('yyyyMMdd-HHmm')
    $swText  = Get-Content -LiteralPath $swPath -Raw
    $swNew   = [regex]::Replace($swText, "const VERSION = '([^']+?)(?:-\d{8}-\d{4})?';", "const VERSION = '`$1-$stampId';", 1)
    if ($swNew -ne $swText) {
      $full = (Resolve-Path -LiteralPath $swPath).Path
      [System.IO.File]::WriteAllText($full, $swNew, (New-Object System.Text.UTF8Encoding($false)))
      Step "stamped service worker version: $stampId"
    }
  }
}

function Reset-Folder([string]$dest) {
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
}

# Each published folder explains itself, because these folders travel: the Android
# one goes to the machine with the SDK, the iOS one to a Mac.
function Write-Note([string]$dest, [string]$text) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm')
  $body  = $text -replace '__STAMP__', $stamp
  Set-Content -LiteralPath (Join-Path $dest 'BUILD-INFO.txt') -Value $body -Encoding UTF8
}

$noteWindows = @'
OpenScene for Windows
=====================

This folder is a complete, runnable copy of OpenScene. Double-click
OpenScene.exe. There is nothing to install and nothing to configure.

  OpenScene.exe                the editor
  OpenScene.exe --devtools     start with the developer tools enabled (F12)
  OpenScene.exe --fullscreen   start maximised
  OpenScene.exe --help         list the command line options

Keep every file in this folder together: OpenScene.exe loads index.html, js\ and
css\ from beside itself. Copy the whole folder, not just the .exe.

Requirements: Windows 10 or 11 (x64). OpenScene renders through the Microsoft
Edge WebView2 runtime, which is already part of Windows. If it is ever missing,
install it free from https://go.microsoft.com/fwlink/p/?LinkId=2124703

Read START-HERE.txt for the short version and README.md for the full manual.

Projects are plain JSON (*.osceneproj) and are portable between platforms.

Published __STAMP__ by tools\Build-AllPlatforms.ps1
'@

$noteAndroid = @'
OpenScene for Android
=====================

This folder is an Android Studio project with the editor already copied in
(app\src\main\assets\www). It needs no AndroidX, no Compose and no Kotlin: the
shell is plain Java against the platform SDK.

To build:

  # open this folder in Android Studio, or from a terminal:
  set JAVA_HOME=<path to JDK 17>
  gradlew.bat assembleDebug
  # -> app\build\outputs\apk\debug\app-debug.apk

  adb install -r app\build\outputs\apk\debug\app-debug.apk

Requirements: JDK 17 and the Android SDK (platform 34, build-tools 34).

The editor files under app\src\main\assets\www were copied from the shared source
tree. If you change the editor on a desktop, re-run the publisher and copy this
folder across again rather than editing both.

See README.md for the host bridge contract and the design notes.

Published __STAMP__ by tools\Build-AllPlatforms.ps1
'@

$noteIOS = @'
OpenScene for iOS
=================

This folder holds the iOS app: the Swift sources, the asset catalog, Info.plist
and the editor copied into www\. It needs macOS and Xcode 15 or newer, because an
iOS app cannot be built on Windows. That is the only reason this folder exists
separately.

To build, on the Mac:

  1. Create the Xcode project once:
       File > New > Project > iOS > App
         Product Name: OpenScene
         Interface:    Storyboard   (delete the storyboard it generates)
         Language:     Swift
     then delete the generated ViewController.swift and AppDelegate.swift.

  2. Drag the OpenScene\ folder into the project (Create groups, do not copy).
     Drag www\ in as a *folder reference* (blue icon) so the paths survive.

  3. Set Info.plist to OpenScene\Info.plist, set the App Icon to AppIcon and the
     Launch Screen to LaunchBackground, and pick your signing team.

  4. Cmd-R.

Alternatively, if you have XcodeGen (brew install xcodegen), the included
project.yml generates the project for you:  xcodegen generate

See README.md for the bridge contract and the design notes.

Published __STAMP__ by tools\Build-AllPlatforms.ps1
'@

Write-Host 'OpenScene - publish by platform' -ForegroundColor Cyan
Step "source     $root"
Step "targets    $downloads"

# ------------------------------------------------------------------ Windows
if (-not $SkipWindows) {
  Head 'Windows  ->  OpenScene-Windows'

  if (-not $WebOnly) {
    Step 'compiling  Build-WindowsApp.ps1 -Clean'
    & (Join-Path $root 'Build-WindowsApp.ps1') -Clean | ForEach-Object { Write-Host "             $_" }
    if ($LASTEXITCODE -ne 0) { throw "Build-WindowsApp.ps1 failed (exit $LASTEXITCODE)" }
  }
  else {
    # -WebOnly keeps the compiled .exe but must still publish *current* editor
    # files. Everything below is copied out of Dist\OpenScene, so refresh that
    # folder from the source tree first - otherwise a JS/CSS edit looks like it
    # published while the old files silently stay in place.
    $ref = Join-Path $root 'Dist\OpenScene'
    if (Test-Path -LiteralPath (Join-Path $ref 'OpenScene.exe')) {
      Step 'refresh    editor files into Dist\OpenScene'
      foreach ($item in @('index.html', 'css', 'js', 'resources', 'icons',
                          'manifest.webmanifest', 'sw.js', 'LICENSE',
                          'README.md', 'CHANGELOG.md')) {
        $src = Join-Path $root $item
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $ref -Recurse -Force }
      }
    }
  }

  $built = Join-Path $root 'Dist\OpenScene'
  $exe   = Join-Path $built 'OpenScene.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "no OpenScene.exe at $built - build it first (drop -WebOnly)" }

  if (-not $WebOnly) { Reset-Folder $winDest }
  else { New-Item -ItemType Directory -Force -Path $winDest | Out-Null }

  # A -WebOnly pass keeps the already-compiled exe and the WebView2 assemblies
  # and refreshes everything else, which is the fast loop while editing CSS/JS.
  $keep = @('.exe', '.dll')
  foreach ($item in (Get-ChildItem -LiteralPath $built -Force)) {
    if ($WebOnly -and $item.PSIsContainer -eq $false -and ($keep -contains $item.Extension.ToLower())) {
      if (Test-Path -LiteralPath (Join-Path $winDest $item.Name)) { continue }
    }
    Copy-Item -LiteralPath $item.FullName -Destination $winDest -Recurse -Force
  }

  $files = (Get-ChildItem -LiteralPath $winDest -Recurse -File | Measure-Object).Count
  $mb    = [Math]::Round((Get-ChildItem -LiteralPath $winDest -Recurse -File | Measure-Object -Sum Length).Sum / 1MB, 1)
  Write-Note $winDest $noteWindows
  Step "published  $winDest  ($files files, $mb MB)"
}

# ------------------------------------------------------------------ Android
if (-not $SkipAndroid) {
  Head 'Android  ->  OpenScene-Android'

  $proj = Join-Path $root 'mobile\android'
  if (-not (Test-Path -LiteralPath $proj)) { throw "missing $proj" }

  Reset-Folder $andDest
  # The Gradle project, minus any previous build output.
  Copy-Item -Path (Join-Path $proj '*') -Destination $andDest -Recurse -Force
  Get-ChildItem -LiteralPath $andDest -Recurse -Directory -Force |
    Where-Object { $_.Name -in @('build', '.gradle') } |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  # Sync the web app into the shell exactly where MainActivity expects it.
  $assets = Join-Path $andDest 'app\src\main\assets'
  if (Test-Path -LiteralPath $assets) { Remove-Item -LiteralPath $assets -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $assets | Out-Null
  Copy-WebApp (Join-Path $assets 'www')
  Copy-Item -LiteralPath (Join-Path $root 'mobile\host-bridge-mobile.js') -Destination $assets -Force

  Write-Note $andDest $noteAndroid
  $files = (Get-ChildItem -LiteralPath $andDest -Recurse -File | Measure-Object).Count
  Step "published  $andDest  ($files files)"
}

# ------------------------------------------------------------------ iOS
if (-not $SkipIOS) {
  Head 'iOS      ->  OpenScene-iOS'

  $proj = Join-Path $root 'mobile\ios'
  if (-not (Test-Path -LiteralPath $proj)) { throw "missing $proj" }

  Reset-Folder $iosDest
  Copy-Item -Path (Join-Path $proj '*') -Destination $iosDest -Recurse -Force
  $www = Join-Path $iosDest 'www'
  if (Test-Path -LiteralPath $www) { Remove-Item -LiteralPath $www -Recurse -Force }
  Copy-WebApp $www

  Write-Note $iosDest $noteIOS
  $files = (Get-ChildItem -LiteralPath $iosDest -Recurse -File | Measure-Object).Count
  Step "published  $iosDest  ($files files)"
}

# ------------------------------------------------------------------ in-tree portable zip
if (-not $NoDist -and -not $SkipWindows) {
  Head 'Dist  ->  portable zip'
  $dist = Join-Path $root 'Dist'
  $src  = Join-Path $dist 'OpenScene'
  $zip  = Join-Path $dist 'OpenScene-portable.zip'
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zip -Force
  $kb = [Math]::Round((Get-Item -LiteralPath $zip).Length / 1KB, 0)
  Step "wrote      $zip  ($kb KB)"
}

Write-Host ''
Write-Host 'DONE' -ForegroundColor Green
Write-Host ("  windows  {0}" -f $winDest)
Write-Host ("  android  {0}" -f $andDest)
Write-Host ("  ios      {0}" -f $iosDest)
Write-Host ''
