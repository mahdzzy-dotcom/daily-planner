; Asks whether to keep or delete the user's data when Daily Planner is uninstalled.
; Skipped for silent uninstalls and for updates, so an update can never delete data.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent skipDeleteData
    MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete your Daily Planner data (tasks, categories and settings)?$\r$\n$\r$\nChoose No to keep your data for a future reinstall." IDNO skipDeleteData
      RMDir /r "$APPDATA\Daily Planner"
    skipDeleteData:
  ${endIf}
!macroend
