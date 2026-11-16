; Приложение ставит скачанное обновление и тихо, при выходе (autoInstallOnAppQuit).
; В тихой установке окно вопроса не показывается, и без /SD ответом было «ничего» —
; установщик доходил до Abort и молча отменял обновление. /SD IDYES — ответ для
; тихого режима; при обычной установке вопрос по-прежнему задаётся человеку.
!macro customInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\4EB839B2-2DAB-4DA7-9E3B-F2E884BBD9A1" "DisplayVersion"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\4EB839B2-2DAB-4DA7-9E3B-F2E884BBD9A1" "DisplayVersion"
  ${EndIf}

  ${IfNot} $0 == ""
    MessageBox MB_ICONQUESTION|MB_YESNO "Найдена установленная версия onlyone (раньше называлось 1code), $0. Продолжить обновление? Предыдущая версия будет удалена автоматически, а локальные чаты будут сохранены." /SD IDYES IDYES +2
    Abort
  ${EndIf}
!macroend

; Keep electron-builder's transactional un.atomicRMDir + restoreFiles path.
; A busy file must abort the update, not be silently overwritten. Never schedule
; deletion of $INSTDIR on reboot: a newer installation may occupy that same path.
; Close the process holding the archive and retry the update instead.

!include MUI2.nsh
!include nsDialogs.nsh

!macro OnlyoneCliText OUT EN RU
  ${If} $LANGUAGE == 1049
    StrCpy ${OUT} "${RU}"
  ${Else}
    StrCpy ${OUT} "${EN}"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var OnlyoneCliEnabled
Var OnlyoneCliCheckbox
Function OnlyoneCliReadChoice
  ReadRegStr $OnlyoneCliEnabled HKCU "Software\onlyone\CLI" "Enabled"
  ${If} $OnlyoneCliEnabled != "0"
    StrCpy $OnlyoneCliEnabled "1"
  ${EndIf}
FunctionEnd

Function OnlyoneCliPage
  Call OnlyoneCliReadChoice
  !insertmacro OnlyoneCliText $0 "Command line" "Командная строка"
  !insertmacro MUI_HEADER_TEXT "$0" "onlyone CLI"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro OnlyoneCliText $0 "Add the onlyone command to my user PATH" "Добавить команду onlyone в PATH моего пользователя"
  ${NSD_CreateCheckbox} 0 12u 100% 24u "$0"
  Pop $OnlyoneCliCheckbox
  ${If} $OnlyoneCliEnabled == "1"
    ${NSD_Check} $OnlyoneCliCheckbox
  ${EndIf}
  !insertmacro OnlyoneCliText $0 "Use onlyone --help in a new terminal. Node.js is not required." "После установки откройте новый терминал: onlyone --help. Node.js не нужен."
  ${NSD_CreateLabel} 0 45u 100% 38u "$0"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function OnlyoneCliPageLeave
  ${NSD_GetState} $OnlyoneCliCheckbox $OnlyoneCliEnabled
FunctionEnd

!macro customPageAfterChangeDir
  Page custom OnlyoneCliPage OnlyoneCliPageLeave
!macroend

!macro customInstall
  ${If} $OnlyoneCliEnabled == ""
    Call OnlyoneCliReadChoice
  ${EndIf}
  StrCpy $2 "$INSTDIR\resources\cli"
  StrCpy $3 "Add"
  ${If} $OnlyoneCliEnabled == "0"
    StrCpy $3 "Remove"
    ReadRegStr $2 HKCU "Software\onlyone\CLI" "Directory"
    ${If} $2 == ""
      StrCpy $2 "$INSTDIR\resources\cli"
    ${EndIf}
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\path.ps1" -Action $3 -Directory "$2"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    DetailPrint "CLI PATH registration failed: $0"
    !insertmacro OnlyoneCliText $1 "Could not update the CLI PATH. The application is installed. Run resources\cli\onlyone.cmd from its installation folder." "Не удалось обновить PATH для CLI. Приложение установлено. Запускайте resources\cli\onlyone.cmd из папки установки."
    MessageBox MB_ICONEXCLAMATION|MB_OK "$1" /SD IDOK
  ${EndIf}
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend
!endif

!macro customUnInstall
  ${IfNot} ${isUpdated}
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\path.ps1" -Action Remove -Directory "$INSTDIR\resources\cli"'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "CLI PATH removal failed: $0"
    ${EndIf}
    SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend
