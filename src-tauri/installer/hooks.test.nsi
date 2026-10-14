; Test harness for hooks.nsh, run by CI (.github/workflows/ci.yml →
; "Uninstaller hook"). Runs NSIS_HOOK_POSTUNINSTALL with the uninstaller
; state given on the command line:
;   makensis /DOUT=<exe> /DUPDATE=0|1 /DDELETE_APP_DATA=0|1 hooks.test.nsi
Unicode true
!include LogicLib.nsh

Name "CoreTools uninstaller hook test"
OutFile "${OUT}"
RequestExecutionLevel user
SilentInstall silent

; The two variables Tauri's uninstaller template declares and the hook reads.
Var UpdateMode
Var DeleteAppDataCheckboxState

!include "hooks.nsh"

Section
  StrCpy $UpdateMode ${UPDATE}
  StrCpy $DeleteAppDataCheckboxState ${DELETE_APP_DATA}
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
