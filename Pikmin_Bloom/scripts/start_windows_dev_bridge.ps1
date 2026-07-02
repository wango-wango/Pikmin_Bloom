param(
  [string]$PythonExe = "",
  [int]$BridgePort = 5680,
  [int]$TunnelPort = 49151
)

$ErrorActionPreference = "Stop"

$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
$LogsDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

function Test-HttpOk {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Resolve-Python {
  if ($PythonExe -and (Test-Path $PythonExe)) {
    return (Resolve-Path $PythonExe).Path
  }

  $candidates = @(
    (Join-Path $ProjectDir ".bridge-temp\venv\Scripts\python.exe"),
    (Join-Path $ProjectDir "release\pikomin-win-portable\venv\Scripts\python.exe"),
    (Join-Path $ProjectDir "release\pikomin-win-portable\python\python.exe")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw "Python runtime not found. Build the portable runtime first, or pass -PythonExe C:\path\to\python.exe."
}

function Start-HostBridge {
  param([string]$RuntimePython)

  $healthUrl = "http://localhost:{0}/health" -f $BridgePort
  if (Test-HttpOk $healthUrl) {
    Write-Host "host bridge already running on $BridgePort"
    return
  }

  $bridgeLog = Join-Path $LogsDir "host_bridge.log"
  $bridgeErr = Join-Path $LogsDir "host_bridge.err.log"
  $env:PMD3_COMMAND = '"' + $RuntimePython + '" -m pymobiledevice3'
  $env:HOST_BRIDGE_LOG_PATH = $bridgeLog

  Start-Process `
    -WindowStyle Hidden `
    -FilePath $RuntimePython `
    -ArgumentList @("-m", "uvicorn", "scripts.host_location_bridge:app", "--host", "127.0.0.1", "--port", "$BridgePort") `
    -WorkingDirectory $ProjectDir `
    -RedirectStandardOutput $bridgeLog `
    -RedirectStandardError $bridgeErr
}

function Start-TunneldElevated {
  param([string]$RuntimePython)

  $tunnelUrl = "http://localhost:{0}" -f $TunnelPort
  if (Test-HttpOk $tunnelUrl) {
    Write-Host "tunneld already running on $TunnelPort"
    return
  }

  $tunnelLog = Join-Path $LogsDir "tunneld.log"
  $tunnelErr = Join-Path $LogsDir "tunneld.err.log"
  $command = @"
Set-Location '$ProjectDir'
`$ErrorActionPreference = 'Stop'
& '$RuntimePython' -m pymobiledevice3 remote tunneld --protocol tcp *> '$tunnelLog' 2> '$tunnelErr'
"@

  Start-Process `
    -Verb RunAs `
    -WindowStyle Hidden `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", $command)
}

$runtimePython = Resolve-Python
Start-HostBridge -RuntimePython $runtimePython
Start-TunneldElevated -RuntimePython $runtimePython

Write-Host "Bridge startup requested. If Windows asks for permission, choose Yes."
Write-Host "Logs: $LogsDir"
