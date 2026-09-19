@echo off
setlocal
chcp 65001 >nul
set "PROJECT_ROOT=%~dp0."
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-dsh-desktop.ps1" -ProjectRoot "%PROJECT_ROOT%" -Uninstall %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo 卸载失败，退出码 %EXIT_CODE%。请查看上方错误信息。
)
if not defined PET_LEARNING_NO_PAUSE pause
exit /b %EXIT_CODE%
