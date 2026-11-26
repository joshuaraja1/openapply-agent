Unicode true
Name "OpenApply"
RequestExecutionLevel user
SetCompressor zlib
CRCCheck force

!ifndef PAYLOAD_ROOT
  !error "PAYLOAD_ROOT is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif

OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\OpenApply\runtime"
ShowInstDetails show
ShowUninstDetails show
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

!ifdef SIGN_SCRIPT
  !uninstfinalize 'powershell.exe -NoProfile -NonInteractive -File "${SIGN_SCRIPT}" "%1"'
  !finalize 'powershell.exe -NoProfile -NonInteractive -File "${SIGN_SCRIPT}" "%1"'
!endif

Function .onInit
  SetShellVarContext current
  StrCmp $INSTDIR "$LOCALAPPDATA\OpenApply\runtime" +2 0
    Abort "OpenApply only installs to the current user's runtime folder."
  IfFileExists "$INSTDIR\*" 0 +2
    Abort "An OpenApply runtime already exists; use the updater when available."
FunctionEnd

Section "OpenApply" SecInstall
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_ROOT}\*"
  FileOpen $0 "$INSTDIR\openapply-install.marker" w
  FileWrite $0 "OpenApply runtime v1"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Function un.onInit
  SetShellVarContext current
  ; NSIS sets $INSTDIR to the original uninstaller location, even after copying
  ; the running uninstaller to a temporary directory.
  StrCmp $INSTDIR "$LOCALAPPDATA\OpenApply\runtime" +2 0
    Abort "Uninstaller is outside the OpenApply runtime folder."
  IfFileExists "$INSTDIR\openapply-install.marker" +2 0
    Abort "OpenApply install marker is missing."
FunctionEnd

Section "Uninstall"
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"
SectionEnd
