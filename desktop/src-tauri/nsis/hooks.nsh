; Kill a previous routing engine so NSIS can replace switchyard-server.exe.
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running routing engine"
  DetailPrint "taskkill /F /IM switchyard-server.exe /T"
  nsExec::ExecToLog 'taskkill /F /IM switchyard-server.exe /T'
  Pop $0
  DetailPrint "Routing engine stop finished (exit $0; 128 means it was not running)"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "${PRODUCTNAME} files are in place"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping routing engine before uninstall"
  nsExec::ExecToLog 'taskkill /F /IM switchyard-server.exe /T'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
