; Custom NSIS hooks for electron-builder.
; On a real uninstall (not an upgrade), let the app remove what it registered outside its folder:
;   - its "forma-data" entry in Claude Desktop's config (backed up first)
;   - the Windows start-up entry
; Your data folder and settings are kept; delete them by hand if you want them gone (see docs/install.md).

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cleanup-before-uninstall'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FormaDataManager"
  ${endIf}
!macroend
