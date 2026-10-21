!include "MUI2.nsh"

Name "OpenScene"
OutFile "..\Dist\OpenScene-Setup.exe"
Unicode True

InstallDir "$PROGRAMFILES64\OpenScene"
InstallDirRegKey HKCU "Software\OpenScene" "InstallDir"

RequestExecutionLevel admin
SetCompressor /SOLID lzma

/* WebView2 cannot be assumed present, and OpenScene is a WebView2 host, so a
   machine without it would install a window that shows nothing. The runtime is
   bundled and installed only when it is missing.

   This is Microsoft's own bootstrapper, embedded here so the download is a
   single file. It is not the ~870 MB runtime: that would turn a 0.6 MB setup
   into a ~200 MB one for the sake of the small number of machines that lack a
   component Windows already ships. On a machine that has WebView2 - Windows 11
   and effectively all Windows 10 - this costs nothing and needs no network. */
!define WV2_BOOTSTRAPPER "..\native\webview2-bootstrapper\MicrosoftEdgeWebview2Setup.exe"
!define WV2_CLIENT "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MUI_ICON "..\resources\icon.ico"
!define MUI_UNICON "..\resources\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "..\resources\installer-header.bmp"
!define MUI_WELCOMEPAGE_TITLE "Welcome to OpenScene"
!define MUI_WELCOMEPAGE_TEXT "OpenScene is a free and open-source, professional video editor for Windows. This installer will copy OpenScene to your computer and create shortcuts."

/* The licence page matters here: OpenScene is offered under the AGPL, and an
   installer that never shows the licence makes that claim hollow. The full text
   ships in the install folder so it can be read at any time. */
!define MUI_LICENSEPAGE_TEXT_TOP "OpenScene is free software, licensed under the GNU Affero General Public License v3.0. You may use, study, share and modify it under those terms."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "A commercial licence is available for organisations that cannot accept the AGPL. See LICENSING.md in the install folder."
!define MUI_LICENSEPAGE_BUTTON "I accept the terms"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

/* Ask the registry whether a WebView2 runtime is already present. Both the
   per-machine (HKLM, 32- and 64-bit views) and per-user (HKCU) installs count;
   a per-user runtime is enough for OpenScene, so any hit means no work to do.
   Returns 1 when a runtime is found. */
Function WebView2Present
  SetRegView 32
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  SetRegView 64
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  ReadRegStr $2 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  StrCmp $0 "" 0 found
  StrCmp $1 "" 0 found
  StrCmp $2 "" 0 found
  Push 0
  Return
found:
  Push 1
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\Dist\OpenScene\*.*"

  CreateDirectory "$SMPROGRAMS\OpenScene"
  CreateShortcut "$SMPROGRAMS\OpenScene\OpenScene.lnk" "$INSTDIR\OpenScene.exe" "" "$INSTDIR\OpenScene.exe" 0
  CreateShortcut "$SMPROGRAMS\OpenScene\Uninstall OpenScene.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
  CreateShortcut "$DESKTOP\OpenScene.lnk" "$INSTDIR\OpenScene.exe" "" "$INSTDIR\OpenScene.exe" 0

  WriteRegStr HKCU "Software\OpenScene" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "DisplayName" "OpenScene"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "DisplayIcon" "$INSTDIR\OpenScene.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "Publisher" "Sparsh Singhal"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "DisplayVersion" "1.2.0"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  /* WebView2 runtime. Only touched when absent, so a normal machine never sees
     a second installer run and never needs a network connection here.
     The bootstrapper is optional: if the build could not obtain it, the payload
     step is skipped and setup simply proceeds without the fallback. */
  Call WebView2Present
  Pop $0
  StrCmp $0 "1" wv2_done

!if /FileExists "${WV2_BOOTSTRAPPER}"
  DetailPrint "Installing the Microsoft Edge WebView2 runtime (required by OpenScene)..."
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=MicrosoftEdgeWebview2Setup.exe" "${WV2_BOOTSTRAPPER}"
  /* /silent makes it install without a UI; /install is the bootstrapper verb. */
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
  DetailPrint "WebView2 install returned $1"

  Call WebView2Present
  Pop $0
  StrCmp $0 "1" wv2_done
  DetailPrint "OpenScene will ask for the WebView2 runtime on first start."
!else
  DetailPrint "The WebView2 runtime was not found, and this build has no copy to install."
  DetailPrint "OpenScene will offer the download link when it starts."
!endif
wv2_done:
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\OpenScene.lnk"
  Delete "$SMPROGRAMS\OpenScene\*.lnk"
  RMDir "$SMPROGRAMS\OpenScene"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\OpenScene"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene"
SectionEnd
