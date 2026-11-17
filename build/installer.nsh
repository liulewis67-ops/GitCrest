!ifndef BUILD_UNINSTALLER
  !macro customInstallMode
    ; Keep the existing install scope, with per-user installation as the default.
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  !macroend

  ; electron-builder 26 checks this spelling before invoking customInstallMode.
  !ifmacrondef customInstallmode
    !macro customInstallmode
      !insertmacro customInstallMode
    !macroend
  !endif

  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipDirectoryForExistingInstall
    !insertmacro MUI_PAGE_DIRECTORY

    Function SkipDirectoryForExistingInstall
      ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} ${isUpdated}
      ${OrIf} $0 != ""
        Abort
      ${EndIf}
    FunctionEnd
  !macroend
!endif
