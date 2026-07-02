$ErrorActionPreference = "Stop"
$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunBat = Join-Path $BaseDir "run.bat"

if (!(Test-Path $RunBat)) {
  Write-Host "Missing launcher: $RunBat"
  exit 1
}

& cmd /c "`"$RunBat`""
