; The Windows installer's own steps (electron-builder.windows.yml, nsis.include).
;
; After the files are in place, the installer asks whether to put a shortcut to Cranium on the desktop; a
; silent install (/S) does not. The uninstaller removes that shortcut with the app. The Start menu entry is
; electron-builder's own (createStartMenuShortcut).

!macro customInstall
  IfSilent craniumNoDesktopShortcut
  MessageBox MB_YESNO|MB_ICONQUESTION "Put a shortcut to Cranium on the desktop?" /SD IDNO IDNO craniumNoDesktopShortcut
  CreateShortCut "$DESKTOP\Cranium.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  craniumNoDesktopShortcut:
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Cranium.lnk"
!macroend
