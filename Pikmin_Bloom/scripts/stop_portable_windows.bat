@echo off
setlocal
set "BASE_DIR=%~dp0"
set "RUNTIME_PY=%BASE_DIR%python\python.exe"
set "SERVICE=%BASE_DIR%windows_service.py"

if not exist "%RUNTIME_PY%" (
  echo Missing bundled Python runtime: %RUNTIME_PY%
  pause
  exit /b 1
)

if not exist "%SERVICE%" (
  echo Missing service launcher: %SERVICE%
  pause
  exit /b 1
)

"%RUNTIME_PY%" "%SERVICE%" stop
pause
endlocal
