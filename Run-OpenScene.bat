@echo off
rem ============================================================================
rem  OpenScene - smart launcher
rem  1. runs the built app if it exists
rem  2. otherwise opens the editor with Microsoft Edge (app mode)
rem
rem  No Node.js, no npm, no installer, no downloads.
rem ============================================================================
setlocal enableextensions
cd /d "%~dp0"

if exist "Dist\OpenScene\OpenScene.exe" (
  echo Starting OpenScene...
  start "" "Dist\OpenScene\OpenScene.exe"
  exit /b 0
)

echo OpenScene has not been built yet - opening the editor in Edge app mode.
echo To build the native app, run Build-Installer.bat.
echo.
call "%~dp0OpenScene-EdgeApp.cmd"
exit /b 0
