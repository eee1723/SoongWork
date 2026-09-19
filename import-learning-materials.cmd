@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: import-learning-materials.cmd "C:\path\to\materials" [-ExternalMedia]
  pause
  exit /b 2
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\import-learning-materials.ps1" -SourceDir "%~1" %2 %3 %4 %5
if errorlevel 1 (
  echo.
  echo Import finished with errors. Review the report path above.
  pause
  exit /b 1
)
echo.
echo Import completed.
pause
