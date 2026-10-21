<#
  Build-WindowsApp.ps1 - builds the native OpenScene Windows application.

  Produces  Dist\OpenScene\OpenScene.exe  - a real Win32 desktop app (no Electron, no
  Node.js, no installer required). It hosts the OpenScene editor in the WebView2 runtime
  that ships with Windows 10/11 and talks to it through native file dialogs.

  Everything here needs only what a stock Windows 10/11 machine already has:
    * the in-box .NET Framework C# compiler (csc.exe, C# 5)
    * the Microsoft.Web.WebView2 SDK assemblies in native\webview2

  Usage:
    powershell -ExecutionPolicy Bypass -File Build-WindowsApp.ps1
    powershell -ExecutionPolicy Bypass -File Build-WindowsApp.ps1 -Clean
    powershell -ExecutionPolicy Bypass -File Build-WindowsApp.ps1 -Shortcut
#>
[CmdletBinding()]
param(
  [switch]$Clean,
  [switch]$Shortcut,
  [switch]$DebugBuild
)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$native = Join-Path $root 'native'
$sdk    = Join-Path $native 'webview2'
$out    = Join-Path $root 'Dist\OpenScene'

function Step($m) { Write-Host "  $m" }
function Warn($m) { Write-Host "  WARNING    $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host ''; Write-Host "BUILD FAILED: $m" -ForegroundColor Red; exit 1 }

Write-Host 'OpenScene - native Windows build' -ForegroundColor Cyan

# ---------------------------------------------------------------- toolchain
$csc = $null
foreach ($p in @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )) {
  if (Test-Path -LiteralPath $p) { $csc = $p; break }
}
if (-not $csc) { Fail 'no in-box C# compiler (csc.exe) was found' }
$fw = Split-Path -Parent $csc
Step "compiler   $csc"

# ---------------------------------------------------------------- WebView2 SDK
$coreDll = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$wfDll   = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$loader  = Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll'
foreach ($f in @($coreDll, $wfDll, $loader)) {
  if (-not (Test-Path -LiteralPath $f)) {
    Fail "the WebView2 SDK is missing a file: $f`n         Re-run tools\fetch-webview2.ps1 to download it."
  }
}
Step 'webview2   SDK found (lib\net462 + win-x64 loader)'

# ------------------------------------------------- WebView2 runtime bootstrapper
# Bundled into the installer so a machine without the runtime is handled by setup
# rather than by the user. Fetched on demand and cached in native\ so a clean clone
# can build the single-file installer with no manual download step. Not fatal when
# unavailable: the installer then ships without the fallback and still works
# wherever WebView2 is already present, which is the normal case.
$wv2Dir  = Join-Path $native 'webview2-bootstrapper'
$wv2Exe  = Join-Path $wv2Dir 'MicrosoftEdgeWebview2Setup.exe'
$wv2Url  = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
if (-not (Test-Path -LiteralPath $wv2Exe)) {
  Step 'webview2   fetching the runtime bootstrapper'
  try {
    New-Item -ItemType Directory -Force -Path $wv2Dir | Out-Null
    $prev = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $wv2Url -OutFile $wv2Exe -UseBasicParsing -MaximumRedirection 5
    $ProgressPreference = $prev
  } catch {
    $ProgressPreference = $prev
    Warn "could not download the WebView2 bootstrapper: $($_.Exception.Message)"
  }
}
if (Test-Path -LiteralPath $wv2Exe) {
  # Trust matters here: this is a runtime installer embedded in ours, so refuse
  # anything that is not signed by Microsoft rather than shipping it silently.
  $sig = Get-AuthenticodeSignature -LiteralPath $wv2Exe
  $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
  if ($sig.Status -eq 'Valid' -and $subject -match 'Microsoft Corporation') {
    Step "webview2   bootstrapper ready ($([math]::Round((Get-Item $wv2Exe).Length / 1MB, 2)) MB, Microsoft-signed)"
  } else {
    Warn "the WebView2 bootstrapper is not validly Microsoft-signed (status $($sig.Status)); it will not be bundled"
    $wv2Exe = $null
  }
} else {
  Warn 'no WebView2 bootstrapper available; the installer will rely on the runtime already being present'
  $wv2Exe = $null
}

# ---------------------------------------------------------------- sources
$sources = @(
  (Join-Path $native 'OpenScene.cs')
)
foreach ($s in $sources) { if (-not (Test-Path -LiteralPath $s)) { Fail "missing source: $s" } }

$icon     = Join-Path $root 'resources\icon.ico'
$manifest = Join-Path $native 'OpenScene.manifest'
$bridge   = Join-Path $native 'host-bridge.js'
foreach ($f in @($icon, $manifest, $bridge)) {
  if (-not (Test-Path -LiteralPath $f)) { Fail "missing build input: $f" }
}
foreach ($f in @('index.html', 'css', 'js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $f))) { Fail "missing editor file: $f" }
}

# ---------------------------------------------------------------- output
if ($Clean -and (Test-Path -LiteralPath $out)) {
  Step 'clean      removing Dist\OpenScene'
  Remove-Item -LiteralPath $out -Recurse -Force
}
if (-not (Test-Path -LiteralPath $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

# ---------------------------------------------------------------- compile
$exe = Join-Path $out 'OpenScene.exe'

$refs = @(
  (Join-Path $fw 'System.dll'),
  (Join-Path $fw 'System.Core.dll'),
  (Join-Path $fw 'System.Drawing.dll'),
  (Join-Path $fw 'System.Windows.Forms.dll'),
  (Join-Path $fw 'System.Web.Extensions.dll'),
  $coreDll,
  $wfDll
)
foreach ($r in $refs) { if (-not (Test-Path -LiteralPath $r)) { Fail "missing reference assembly: $r" } }

$cscArgs = New-Object System.Collections.Generic.List[string]
$cscArgs.Add('/nologo')
$cscArgs.Add('/target:winexe')
$cscArgs.Add('/platform:x64')
$cscArgs.Add('/langversion:5')
$cscArgs.Add('/optimize+')
$cscArgs.Add('/utf8output')
$cscArgs.Add('/nowarn:1591,0618')
if ($DebugBuild) {
  $cscArgs.Add('/define:DEBUG')
  $cscArgs.Add('/debug+')
} else {
  $cscArgs.Add('/debug-')
}
$cscArgs.Add("/win32icon:$icon")
$cscArgs.Add("/win32manifest:$manifest")
$cscArgs.Add("/resource:$bridge,host-bridge.js")
foreach ($r in $refs) { $cscArgs.Add("/reference:$r") }
$cscArgs.Add("/out:$exe")
foreach ($s in $sources) { $cscArgs.Add($s) }

Step 'compile    csc.exe -> OpenScene.exe'
$cscArgv = $cscArgs.ToArray()
$compileOutput = & $csc @cscArgv 2>&1
$compileOutput | Where-Object { $_ -and "$_".Trim() } | ForEach-Object { Write-Host "             $_" }
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
  Fail "the compiler reported errors (exit $LASTEXITCODE)"
}

# ---------------------------------------------------------------- assemble
Step 'copy       WebView2 runtime assemblies'
Copy-Item -LiteralPath $coreDll -Destination $out -Force
Copy-Item -LiteralPath $wfDll   -Destination $out -Force
Copy-Item -LiteralPath $loader  -Destination $out -Force

Step 'copy       editor files'
foreach ($item in @('index.html', 'css', 'js', 'resources', 'icons', 'manifest.webmanifest', 'sw.js', 'LICENSE')) {
  $src = Join-Path $root $item
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination $out -Recurse -Force
  }
}
foreach ($doc in @('README.md', 'CHANGELOG.md', 'LICENSING.md', 'CLA.md', 'LICENSE-MIT')) {
  $src = Join-Path $root $doc
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $out -Force }
}

# A tiny text file so the folder explains itself. Written as an array of lines and
# joined with CRLF so the encoding and line endings are identical on every run.
$txtLines = @(
  'OpenScene - native Windows app'
  '============================='
  ''
  'Run OpenScene.exe to start the editor.'
  ''
  '  OpenScene.exe                 the editor'
  '  OpenScene.exe --devtools      start with the developer tools enabled (F12)'
  '  OpenScene.exe --fullscreen    start maximised'
  '  OpenScene.exe --help          list the command line options'
  ''
  'Requirements: Windows 10 or Windows 11. OpenScene uses the Microsoft Edge WebView2'
  'runtime, which is already part of Windows 10 and Windows 11. If it is ever missing,'
  'the installer adds it automatically, or you can install it free from'
  'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
  ''
  'Keep every file in this folder together - OpenScene.exe looks for index.html, js\ and'
  'css\ right next to itself.'
  ''
  'Projects are plain JSON files ( *.oscene ) and are fully portable. OpenShot .osp projects import directly.'
  ''
  'OpenScene is free and open source software, released under the GNU Affero'
  'General Public License v3.0. See LICENSE for details. A commercial licence is'
  'available for organisations that cannot accept the AGPL - see LICENSING.md.'
)
$txt = ($txtLines -join "`r`n") + "`r`n"
Set-Content -LiteralPath (Join-Path $out 'START-HERE.txt') -Value $txt -Encoding UTF8

# ---------------------------------------------------------------- optional shortcut
if ($Shortcut) {
  Step 'shortcut   Start Menu + Desktop'
  $shell = New-Object -ComObject WScript.Shell
  $targets = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'OpenScene.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop'))  'OpenScene.lnk')
  )
  foreach ($lnkPath in $targets) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $exe
    $lnk.WorkingDirectory = $out
    $lnk.IconLocation     = "$exe,0"
    $lnk.Description      = 'OpenScene - free and open-source video editor'
    $lnk.Save()
    Write-Host "             $lnkPath"
  }
}

# ---------------------------------------------------------------- portable zip
# One archive you can hand to somebody who does not want an installer: unzip and
# double-click OpenScene.exe. Built from the same verified output folder.
$zip = Join-Path (Split-Path -Parent $out) 'OpenScene-portable.zip'
try {
  Step 'portable   OpenScene-portable.zip'
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -CompressionLevel Optimal -Force
  Write-Host ("             {0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))
} catch {
  Write-Host ('             skipped: ' + $_.Exception.Message) -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- report
$exeSize = (Get-Item -LiteralPath $exe).Length
$totalSize = (Get-ChildItem -LiteralPath $out -Recurse -File | Measure-Object -Sum Length).Sum
Write-Host ''
Write-Host 'BUILD OK' -ForegroundColor Green
Write-Host ("  app      {0}" -f $exe)
Write-Host ("  exe      {0:N0} bytes" -f $exeSize)
Write-Host ("  folder   {0:N1} MB" -f ($totalSize / 1MB))
if (Test-Path -LiteralPath $zip) { Write-Host ("  portable {0}" -f $zip) }
Write-Host ''
Write-Host ("Run it:   `"{0}`"" -f $exe) -ForegroundColor Cyan
