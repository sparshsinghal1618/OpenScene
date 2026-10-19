!include "MUI2.nsh"

Name "OpenScene"
OutFile "..\Dist\OpenScene-Setup.exe"
Unicode True

InstallDir "$PROGRAMFILES64\OpenScene"
InstallDirRegKey HKCU "Software\OpenScene" "InstallDir"

RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_ICON "..\resources\icon.ico"
!define MUI_UNICON "..\resources\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "..\resources\installer-header.bmp"
!define MUI_WELCOMEPAGE_TITLE "Welcome to OpenScene"
!define MUI_WELCOMEPAGE_TEXT "OpenScene is a free and open-source, professional video editor for Windows. This installer will copy OpenScene to your computer and create shortcuts."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

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
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "Publisher" "OpenScene"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "DisplayVersion" "1.0.0"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\OpenScene.lnk"
  Delete "$SMPROGRAMS\OpenScene\*.lnk"
  RMDir "$SMPROGRAMS\OpenScene"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\OpenScene"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenScene"
SectionEnd
