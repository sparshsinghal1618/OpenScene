@echo off
rem ============================================================================
rem  OpenScene - zero-install launcher (Microsoft Edge app mode)
rem  Runs the editor in a chromeless Edge window: no Node.js, no installer.
rem  Double-click this file.
rem ============================================================================
setlocal enableextensions
set "ROOT=%~dp0"
set "PAGE=file:///%ROOT:\=/%index.html"
set "PROFILE=%LOCALAPPDATA%\OpenScene\edge-profile"

set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE for /f "delims=" %%E in ('where msedge 2^>nul') do if not defined EDGE set "EDGE=%%E"

if not defined EDGE (
  echo.
  echo   Microsoft Edge was not found on this system.
  echo   Install Microsoft Edge, or build the native app with Build-Installer.bat.
  echo.
  pause
  exit /b 1
)

if not exist "%ROOT%index.html" (
  echo.
  echo   index.html was not found next to this launcher.
  echo   Keep OpenScene-EdgeApp.cmd in the OpenScene folder.
  echo.
  pause
  exit /b 1
)

echo Launching OpenScene in Edge app mode...
start "" "%EDGE%" --app="%PAGE%" --user-data-dir="%PROFILE%" --start-maximized --no-first-run --disable-features=msEdgeSidebarV2,msEdgeIdentityDefaultBrowser
exit /b 0
