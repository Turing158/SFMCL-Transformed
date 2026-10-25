; Tauri includes installerHooks before its standard pages. The environment page
; therefore comes first; the remaining installation/uninstallation flow is Tauri's.
!include LogicLib.nsh
!include nsDialogs.nsh
!include FileFunc.nsh
!include WordFunc.nsh
!include x64.nsh

!ifndef SFMCL_T_WEBVIEW_REGKEY
  !define SFMCL_T_WEBVIEW_REGKEY "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!endif
!define SFMCL_T_WEBVIEW_HELPER "${__FILEDIR__}\install-webview2.ps1"

Var SFMCLTWebViewVersion
Var SFMCLTWebViewSelected
Var SFMCLTWebViewChoiceInitialized
Var SFMCLTWebViewCheckbox
Var SFMCLTWebViewDialog

Page custom SFMCLTWebViewPageCreate SFMCLTWebViewPageLeave

!macro SFMCL_T_READ_WEBVIEW_VERSION ROOT
  ReadRegStr $0 ${ROOT} "${SFMCL_T_WEBVIEW_REGKEY}" "pv"
  ${If} $0 != ""
    ${VersionCompare} $0 "0.0.0.0" $1
    ${If} $1 == 1
      StrCpy $SFMCLTWebViewVersion $0
      Goto sfmcl_t_webview_detect_done
    ${EndIf}
  ${EndIf}
!macroend

Function SFMCLTDetectWebView2
  Push $0
  Push $1
  StrCpy $SFMCLTWebViewVersion ""
  ; Evergreen can be registered per machine or per user, in either registry view.
  SetRegView 32
  !insertmacro SFMCL_T_READ_WEBVIEW_VERSION HKLM
  !insertmacro SFMCL_T_READ_WEBVIEW_VERSION HKCU
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro SFMCL_T_READ_WEBVIEW_VERSION HKLM
    !insertmacro SFMCL_T_READ_WEBVIEW_VERSION HKCU
  ${EndIf}
  sfmcl_t_webview_detect_done:
  ; These packages target x64; restore the view used by Tauri's SetContext.
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    SetRegView 32
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function SFMCLTInitializeWebViewChoice
  Call SFMCLTDetectWebView2
  ${If} $SFMCLTWebViewVersion != ""
    StrCpy $SFMCLTWebViewSelected ${BST_UNCHECKED}
  ${ElseIf} $SFMCLTWebViewChoiceInitialized != 1
    StrCpy $SFMCLTWebViewSelected ${BST_CHECKED}
  ${EndIf}
  StrCpy $SFMCLTWebViewChoiceInitialized 1
FunctionEnd

Function SFMCLTWebViewPageCreate
  Call SFMCLTInitializeWebViewChoice
  ; In passive mode the choice is still initialized, but no interaction is needed.
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $SFMCLTWebViewDialog
  ${If} $SFMCLTWebViewDialog == error
    Abort
  ${EndIf}
  ; Use the MUI header controls directly: MUI's variables are declared later in
  ; Tauri's template, after this hook has been included.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:运行环境"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:选择是否下载并安装 SFMCL-T 所需的 WebView2。"
  ${NSD_CreateLabel} 0 0 100% 34u "SFMCL-T 需要 Microsoft WebView2 Runtime。安装包不包含运行环境；勾选后将在安装时从微软下载。"
  Pop $0
  ${NSD_CreateCheckbox} 0 48u 100% 20u "下载并安装 Microsoft WebView2 Runtime"
  Pop $SFMCLTWebViewCheckbox
  ${NSD_SetState} $SFMCLTWebViewCheckbox $SFMCLTWebViewSelected
  ${If} $SFMCLTWebViewVersion != ""
    EnableWindow $SFMCLTWebViewCheckbox 0
    ${NSD_CreateLabel} 0 80u 100% 34u "已检测到 WebView2 $SFMCLTWebViewVersion，无需重复安装。"
    Pop $0
  ${Else}
    ${NSD_CreateLabel} 0 80u 100% 44u "未检测到 WebView2，已默认勾选。安装环境需要联网；如果取消勾选，请自行准备环境后再运行启动器。"
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function SFMCLTWebViewPageLeave
  ${NSD_GetState} $SFMCLTWebViewCheckbox $SFMCLTWebViewSelected
FunctionEnd

Function SFMCLTInstallWebView2
  ; Also runs for /S and /P, where the interactive page can be skipped.
  Call SFMCLTInitializeWebViewChoice
  ${If} $SFMCLTWebViewVersion != ""
    DetailPrint "已安装 WebView2 $SFMCLTWebViewVersion，跳过环境安装。"
    Return
  ${EndIf}
  ${If} $SFMCLTWebViewSelected != ${BST_CHECKED}
    DetailPrint "未选择 WebView2；仅安装 SFMCL-T。"
    Return
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\install-webview2.ps1" "${SFMCL_T_WEBVIEW_HELPER}"
  DetailPrint "正在下载并安装 Microsoft WebView2 Runtime..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-webview2.ps1"'
  Pop $0
  ${If} $0 == 3010
  ${OrIf} $0 == 1641
    SetRebootFlag true
    Return
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 1
    Abort "WebView2 下载或安装失败（错误码 $0）。请检查网络后重试，或自行安装 WebView2。"
  ${EndIf}
  Call SFMCLTDetectWebView2
  ${If} $SFMCLTWebViewVersion == ""
    SetErrorLevel 1
    Abort "WebView2 安装后仍未检测到环境，请重试或自行安装。"
  ${EndIf}
  DetailPrint "WebView2 $SFMCLTWebViewVersion 已就绪。"
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call SFMCLTInstallWebView2
!macroend
