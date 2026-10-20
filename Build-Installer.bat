@echo off
rem ============================================================================
rem  OpenScene - build the Windows app and the installer
rem
rem  Produces:
rem    Dist\OpenScene\OpenScene.exe   the editor (native WebView2 host)
rem    Dist\OpenScene-Setup.exe       the NSIS installer
rem
rem  No Node.js, no npm, no downloads. It uses the C# compiler that ships with
rem  Windows for the app, and NSIS (if installed) for the installer.
rem ============================================================================
setlocal enableextensions
cd /d "%~dp0"

set "PWSH=powershell -NoProfile -ExecutionPolicy Bypass -File"

echo.
echo Building the OpenScene app...
%PWSH% "Build-WindowsApp.ps1" -Clean
if errorlevel 1 (
  echo.
  echo   The app build failed.
  echo.
  pause
  exit /b 1
)

set "MAKENSIS="
if exist "%ProgramFiles(x86)%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles(x86)%\NSIS\makensis.exe"
if not defined MAKENSIS if exist "%ProgramFiles%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles%\NSIS\makensis.exe"
if not defined MAKENSIS for /f "delims=" %%M in ('where makensis 2^>nul') do if not defined MAKENSIS set "MAKENSIS=%%M"

if not defined MAKENSIS (
  echo.
  echo ============================================================
  echo  The app is built:  Dist\OpenScene\OpenScene.exe
  echo.
  echo  NSIS was not found, so the installer was skipped. It is
  echo  free from https://nsis.sourceforge.io/ - install it and
  echo  run this file again to produce Dist\OpenScene-Setup.exe.
  echo ============================================================
  echo.
  pause
  exit /b 0
)

echo.
echo Building the installer...
"%MAKENSIS%" /V2 "tools\OpenScene.nsi"
if errorlevel 1 (
  echo.
  echo   The installer build failed.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Done. Look in the "Dist" folder for:
echo    OpenScene\OpenScene.exe    ^(run this^)
echo    OpenScene-Setup.exe        ^(single-file installer - this is the one to share^)
echo    OpenScene-portable.zip     ^(unzip and run, no install^)
echo ============================================================
echo.
pause
exit /b 0
