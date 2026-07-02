@echo off
setlocal
set "BASE_DIR=%~dp0"
set "RUNTIME_PY=%BASE_DIR%python\python.exe"
set "SERVICE=%BASE_DIR%windows_service.py"

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Pikomin needs administrator privileges to start the iOS tunnel.
  echo A Windows permission prompt will open now.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
  exit /b
)

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

echo Starting Pikomin in the background...
"%RUNTIME_PY%" "%SERVICE%"
if errorlevel 1 (
  echo.
  echo Pikomin may not have started correctly. Check the logs folder.
  pause
  exit /b 1
)

echo You can close this window. Use stop.bat to stop Pikomin.
endlocal
