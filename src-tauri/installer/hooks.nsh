; NSIS hooks for the Windows installer (tauri.conf.json → bundle.windows.nsis.installerHooks).
; Tauri inserts each macro into the installer template (installer/installer.nsi).

; Deleting the vault is permanent: confirm it, defaulting to No.
;
; "Delete the application data" erases the Authenticator accounts, saved logins
; and settings on this PC (and, below, the Google sign-in). Updates never get
; here — the installer runs the previous uninstaller with /UPDATE /P (see
; scripts/installer-template.mjs) — so this is a real uninstall. People still
; tick the box thinking it tidies up, so say plainly what it erases and make
; No the default. Silent uninstalls never show the box; /SD keeps data anyway.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "Also delete your CoreTools data on this computer?$\n$\nThis permanently erases your Authenticator accounts, saved logins and settings here, and signs this PC out of Google Drive backup. Backups already in Google Drive or saved to files are not affected.$\n$\nUpdating to a newer version? Choose No - updates never need this." \
      /SD IDNO IDYES coretools_delete_data_confirmed
    StrCpy $DeleteAppDataCheckboxState 0
    DetailPrint "Kept your CoreTools data on this computer."
    coretools_delete_data_confirmed:
  ${EndIf}
!macroend

; Forget the Google Drive sign-in together with the rest of the app's data.
;
; Cloud backup keeps its Google sign-in (refresh token + account email) in
; Windows Credential Manager, which belongs to the Windows user, not to the
; install folder: uninstalling alone leaves it behind, and a reinstall shows
; the account as still connected. Remove it exactly when Tauri removes the
; app's data — "Delete the application data" ticked and not an update — so a
; plain uninstall/reinstall still keeps the vault and its connection together.
;
; The target name is keyring's "<user>.<service>" for KEYRING_USER and
; KEYRING_SERVICE in src/cloud.rs (a unit test there keeps the two in sync).
; CredDeleteW(TargetName, CRED_TYPE_GENERIC = 1, Flags = 0); a missing entry
; just returns FALSE, and the result is ignored so no register is clobbered.
; This only deletes the local copy: the "Disconnect" button also revokes the
; token at Google.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    System::Call 'advapi32::CredDeleteW(w "google.io.coretools.authenticator.cloud", i 1, i 0)'
  ${EndIf}
!macroend
