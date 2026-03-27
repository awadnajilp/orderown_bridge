; build/installer.nsh
; Custom NSIS hooks for OrderOwn Bridge installer

; ── On install: add app to Windows startup (HKCU — no admin needed) ─────────
!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "OrderOwnBridge" "$INSTDIR\OrderOwn Bridge.exe"
!macroend

; ── On uninstall: remove from startup ────────────────────────────────────────
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "OrderOwnBridge"
!macroend
