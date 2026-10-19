<#
Build-AndroidApp.ps1 - Build OpenScene Android APK (no Gradle)
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$tc = Join-Path $root 'tools\android-toolchain'
$jdkDir = Join-Path $tc 'jdk-17'
$sdkDir = Join-Path $tc 'android-sdk'
$cmdlineDir = Join-Path $sdkDir 'cmdline-tools\latest'
$buildToolsDir = Join-Path $sdkDir 'build-tools'
$platformsDir = Join-Path $sdkDir 'platforms'
$outputs = Join-Path $tc 'outputs'
New-Item -ItemType Directory -Force -Path $tc,$outputs,$jdkDir,$sdkDir,$buildToolsDir,$platformsDir | Out-Null

$hasJava = (Test-Path (Join-Path $jdkDir 'bin\java.exe')) -and (Test-Path (Join-Path $jdkDir 'bin\javac.exe'))
$btList = Get-ChildItem -Path $buildToolsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '34.*' }
$btLatestDir = if ($btList) { ($btList | Sort-Object Name -Descending | Select-Object -First 1).FullName } else { $null }
$hasPlat = Test-Path (Join-Path $platformsDir 'android-34')
$hasCmdline = Test-Path (Join-Path $cmdlineDir 'bin\sdkmanager.bat')
$hasSdk = $hasCmdline -and $btLatestDir -and $hasPlat

if (-not $hasJava) {
  Write-Host 'Downloading JDK 17...'
  $u = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk'
  $zip = Join-Path $tc 'jdk17.zip'
  Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing
  if (Test-Path $jdkDir) { Remove-Item $jdkDir -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tc -Force
  $top = Get-ChildItem $tc -Directory | Where-Object { $_.Name -like 'jdk*' } | Select-Object -First 1
  if ($top) { Move-Item $top.FullName $jdkDir -Force }
  Remove-Item $zip -Force
}

$env:JAVA_HOME = $jdkDir
$env:PATH = "$jdkDir\bin;" + $env:PATH

if (-not $hasSdk) {
  Write-Host 'Downloading Android SDK...'
  $cu = 'https://dl.google.com/android/repository/commandlinetools-win-10406996_latest.zip'
  $czip = Join-Path $tc 'cmdline.zip'
  Invoke-WebRequest -Uri $cu -OutFile $czip -UseBasicParsing
  $cbase = Join-Path $sdkDir 'cmdline-tools'
  if (Test-Path $cbase) { Remove-Item $cbase -Recurse -Force }
  Expand-Archive -Path $czip -DestinationPath $cbase -Force
  $m = Join-Path $cbase 'cmdline-tools'
  if (Test-Path $m) { Move-Item $m (Join-Path $cbase 'latest') -Force }
  Remove-Item $czip -Force
  $env:ANDROID_HOME = $sdkDir
  $env:ANDROID_SDK_ROOT = $sdkDir
  $env:PATH = "$cmdlineDir\bin;$sdkDir\platform-tools;" + $env:PATH
  $sm = Join-Path $cmdlineDir 'bin\sdkmanager.bat'
  $y = Join-Path $tc 'y.txt'
  "yes" * 20 | Out-File -FilePath $y -Encoding ASCII -NoNewline
  cmd /c "type `"$y`" | `"$sm`" --licenses" 2>$null
  & $sm "platforms;android-34" "build-tools;34.0.0" "platform-tools" 2>&1 | Out-Null
  Remove-Item $y -Force
} else {
  $env:ANDROID_HOME = $sdkDir
  $env:ANDROID_SDK_ROOT = $sdkDir
  $env:PATH = "$jdkDir\bin;$cmdlineDir\bin;$sdkDir\platform-tools;" + $env:PATH
}

$btList2 = Get-ChildItem -Path $buildToolsDir -Directory | Where-Object { $_.Name -like '34.*' } | Sort-Object Name -Descending | Select-Object -First 1
$btDir = $btList2.FullName
$aapt2 = Join-Path $btDir 'aapt2.exe'
$d8 = Join-Path $btDir 'd8.bat'
$zipalign = Join-Path $btDir 'zipalign.exe'
$apksigner = Join-Path $btDir 'apksigner.bat'
$aj = Join-Path $platformsDir 'android-34\android.jar'

& "$root\mobile\android\sync-assets.ps1"

$and = Join-Path $root 'mobile\android'
$man = Join-Path $and 'app\src\main\AndroidManifest.xml'
$res = Join-Path $and 'app\src\main\res'
$javaSrc = Join-Path $and 'app\src\main\java'
$assets = Join-Path $and 'app\src\main\assets'
$out = Join-Path $and 'app\build'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$out\classes","$out\outputs\apk\debug" | Out-Null

$cres = Join-Path $out 'compiled_res.zip'
& $aapt2 compile --dir $res -o $cres 2>&1 | Out-Null
$rzip = Join-Path $out 'r.zip'
& $aapt2 link -o $rzip --manifest $man -I $aj --auto-add-overlay -R $cres --java $javaSrc --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name 1.0.0 2>&1 | Out-Null
Expand-Archive -Path $rzip -DestinationPath (Join-Path $out 'linked') -Force

$cls = Join-Path $out 'classes'
New-Item -ItemType Directory -Force -Path $cls | Out-Null
$jfs = Get-ChildItem $javaSrc -Recurse -File -Filter *.java
if ($jfs) { & javac -d $cls -classpath $aj $jfs.FullName 2>&1 | Out-Null }

$dx = Join-Path $out 'classes.dex'
$clsFiles = Get-ChildItem -Path $cls -Recurse -File -Filter *.class | Select-Object -ExpandProperty FullName
$classArgs = ($clsFiles | ForEach-Object { "`"$_`"" }) -join ' '
$cmdline = "`"$d8`" --lib `"$aj`" --min-api 24 --output `"$out`" $classArgs"
cmd /c $cmdline 2>&1 | Out-Null
Move-Item (Join-Path $out 'classes.dex') $dx -Force

$unsigned = Join-Path $out 'outputs\apk\debug\app-debug-unsigned.apk'
Copy-Item $rzip $unsigned -Force
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$za = [System.IO.Compression.ZipFile]::Open($unsigned,'Update')
try {
  $e = $za.CreateEntry('classes.dex').Open()
  $fs = [IO.File]::OpenRead($dx)
  $fs.CopyTo($e); $fs.Close(); $e.Close()
} finally { $za.Dispose() }
$za2 = [System.IO.Compression.ZipFile]::Open($unsigned,'Update')
try {
  Get-ChildItem $assets -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($assets.Length).TrimStart('\','/') -replace '\\','/'
    $en = $za2.CreateEntry("assets/$rel",[IO.Compression.CompressionLevel]::Fastest).Open()
    $fs = [IO.File]::OpenRead($_.FullName); $fs.CopyTo($en); $fs.Close(); $en.Close()
  }
} finally { $za2.Dispose() }

$aligned = Join-Path $out 'outputs\apk\debug\app-debug-aligned.apk'
& $zipalign -v 4 $unsigned $aligned 2>&1 | Out-Null
$apk = Join-Path $out 'outputs\apk\debug\app-debug.apk'
$key = Join-Path $tc 'debug.keystore'
if (-not (Test-Path $key)) {
  keytool -genkeypair -v -keystore $key -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=OpenScene Debug,OU=OpenScene,O=OpenScene,L=NA,S=NA,C=US" 2>$null | Out-Null
}
& cmd /c "`"$apksigner`" sign --ks `"$key`" --ks-pass pass:android --key-pass pass:android --out `"$apk`" `"$aligned`"" 2>&1 | Out-Null
Copy-Item $apk (Join-Path $outputs 'app-debug.apk') -Force
$sz = [Math]::Round((Get-Item $apk).Length/1MB,2)
Write-Host "APK: $apk ($sz MB)" -ForegroundColor Green
Write-Host "Copied: $outputs\app-debug.apk" -ForegroundColor Green
