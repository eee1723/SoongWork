@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-siliconflow.ps1"
if errorlevel 1 (
  echo.
  echo SiliconFlow setup failed. Review the message above.
  pause
  exit /b 1
)
echo.
echo SiliconFlow credential setup completed. Restart DSH Desktop before use.
pause
