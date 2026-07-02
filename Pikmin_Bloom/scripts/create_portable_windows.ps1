param(
  [string]$PythonExe = "python",
  [string]$ProjectDir = "",
  [string]$NodeExe = "",
  [string]$PythonVersion = "3.12.10",
  [switch]$BuildExe
)

$ErrorActionPreference = "Stop"

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

function Optimize-PortableRuntime {
  param(
    [Parameter(Mandatory = $true)]
    [string]$VenvDir
  )

  $SitePackages = Join-Path $VenvDir "Lib\site-packages"
  if (!(Test-Path $SitePackages)) { return }

  Write-Host "Optimizing portable runtime..."

  Get-ChildItem $VenvDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Get-ChildItem $VenvDir -Recurse -File -Include "*.pyc", "*.pyo" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

  $removePatterns = @(
    "pip",
    "pip-*.dist-info",
    "setuptools",
    "setuptools-*.dist-info",
    "wheel",
    "wheel-*.dist-info",
    "pythonwin",
    "Crypto\SelfTest",
    "jedi\third_party\typeshed",
    "win32\test",
    "win32com\test"
  )

  foreach ($pattern in $removePatterns) {
    Get-ChildItem -Path (Join-Path $SitePackages $pattern) -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }

  Get-ChildItem $VenvDir -Recurse -Directory -Filter ".pytest_cache" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Repair-PortablePermissions {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if ($env:OS -ne "Windows_NT" -or !(Test-Path $Path)) { return }

  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  Write-Host "Repairing portable runtime permissions..."
  & icacls $Path /inheritance:e /grant "$($Identity):(OI)(CI)F" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Permission repair reported warnings. Continuing because zip packaging does not preserve NTFS ACLs."
  }
}

function New-PortablePython {
  param(
    [Parameter(Mandatory = $true)]
    [string]$OutDir,
    [Parameter(Mandatory = $true)]
    [string]$PythonVersion,
    [Parameter(Mandatory = $true)]
    [string]$BuildPythonExe
  )

  $PythonDir = Join-Path $OutDir "python"
  $CacheDir = Join-Path (Split-Path -Parent $OutDir) "python-cache"
  $EmbedZip = Join-Path $CacheDir "python-$PythonVersion-embed-amd64.zip"
  $Url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"

  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  if (!(Test-Path $EmbedZip)) {
    Write-Host "Downloading Python embeddable runtime $PythonVersion..."
    Invoke-WebRequest -Uri $Url -OutFile $EmbedZip
  }

  if (Test-Path $PythonDir) { Remove-Item -Recurse -Force $PythonDir }
  New-Item -ItemType Directory -Force -Path $PythonDir | Out-Null
  Expand-Archive -Path $EmbedZip -DestinationPath $PythonDir -Force

  $SitePackages = Join-Path $PythonDir "Lib\site-packages"
  New-Item -ItemType Directory -Force -Path $SitePackages | Out-Null

  $Pth = Get-ChildItem $PythonDir -Filter "python*._pth" | Select-Object -First 1
  if ($Pth) {
    $PthContent = @(
      "python312.zip",
      ".",
      "Lib\site-packages",
      "import site"
    )
    $PthContent | Out-File -Encoding ascii $Pth.FullName
  }

  Invoke-Native $BuildPythonExe -m pip install --upgrade --ignore-installed --no-cache-dir --target $SitePackages `
    "fastapi>=0.111.0" `
    "uvicorn[standard]>=0.29.0" `
    "pymobiledevice3>=4.14.0" `
    "httpx>=0.27.0"

  Repair-PortablePermissions -Path $PythonDir
  Optimize-PortableRuntime -VenvDir $PythonDir
}

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
  $ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
}

$OutDir = Join-Path $ProjectDir "release\pikomin-win-portable"

Write-Host "[1/6] Clean output directory..."
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "[2/6] Build frontend..."
Push-Location (Join-Path $ProjectDir "frontend")
$env:VITE_API_URL = ""
$NpmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
$Npm = Get-Command npm -ErrorAction SilentlyContinue
function Invoke-NodeBuild {
  if ([string]::IsNullOrWhiteSpace($NodeExe)) {
    $NodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($NodeCmd) { $NodeExe = $NodeCmd.Source }
  }
  if ([string]::IsNullOrWhiteSpace($NodeExe) -or !(Test-Path $NodeExe)) {
    throw "Node.js/npm not found. Pass -NodeExe C:\path\to\node.exe or install Node.js."
  }
  Invoke-Native $NodeExe ".\node_modules\typescript\bin\tsc" -p ".\tsconfig.json"
  Invoke-Native $NodeExe ".\node_modules\vite\bin\vite.js" build
}

try {
  if (-not [string]::IsNullOrWhiteSpace($NodeExe)) {
    Invoke-NodeBuild
  } elseif ($NpmCmd) {
    Invoke-Native $NpmCmd.Source run build
  } elseif ($Npm) {
    Invoke-Native $Npm.Source run build
  } else {
    Invoke-NodeBuild
  }
} catch {
  Write-Host "npm build unavailable, falling back to direct node build..."
  Invoke-NodeBuild
}
Pop-Location

Write-Host "[3/6] Copy runtime files..."
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "backend") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "frontend") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "docs") | Out-Null

Copy-Item -Recurse -Force (Join-Path $ProjectDir "backend\app") (Join-Path $OutDir "backend\app")
Copy-Item -Force (Join-Path $ProjectDir "backend\requirements.txt") (Join-Path $OutDir "backend\requirements.txt")
Copy-Item -Recurse -Force (Join-Path $ProjectDir "frontend\dist") (Join-Path $OutDir "frontend\dist")
Copy-Item -Force (Join-Path $ProjectDir "docs\*.md") (Join-Path $OutDir "docs\") -ErrorAction SilentlyContinue
Copy-Item -Force (Join-Path $ProjectDir "docs\*.html") (Join-Path $OutDir "docs\") -ErrorAction SilentlyContinue
"DOC_VERSION=$((Get-Date).ToString('yyyy-MM-dd_HH-mm-ss'))" | Out-File -Encoding utf8 (Join-Path $OutDir "docs\DOC_VERSION.txt")

Write-Host "[4/6] Create portable Python runtime..."
New-PortablePython -OutDir $OutDir -PythonVersion $PythonVersion -BuildPythonExe $PythonExe

Write-Host "[5/6] Create portable launchers..."
Copy-Item -Force (Join-Path $ProjectDir "scripts\run_portable_windows.bat") (Join-Path $OutDir "run.bat")
Copy-Item -Force (Join-Path $ProjectDir "scripts\run_portable_windows.ps1") (Join-Path $OutDir "run.ps1")
Copy-Item -Force (Join-Path $ProjectDir "scripts\stop_portable_windows.bat") (Join-Path $OutDir "stop.bat")
Copy-Item -Force (Join-Path $ProjectDir "scripts\windows_launcher.py") (Join-Path $OutDir "windows_launcher.py")
Copy-Item -Force (Join-Path $ProjectDir "scripts\windows_service.py") (Join-Path $OutDir "windows_service.py")
Copy-Item -Force (Join-Path $ProjectDir "scripts\pymobiledevice3_portable.py") (Join-Path $OutDir "pymobiledevice3_portable.py")
Copy-Item -Force (Join-Path $ProjectDir "scripts\uvicorn_portable.py") (Join-Path $OutDir "uvicorn_portable.py")

if ($BuildExe) {
  Write-Host "[5.5/6] Build PikominLauncher.exe..."
  Invoke-Native $PythonExe -m pip install pyinstaller
  Push-Location $OutDir
  Invoke-Native $PythonExe -m PyInstaller `
    --onefile `
    --name PikominLauncher `
    windows_launcher.py
  Copy-Item -Force (Join-Path $OutDir "dist\PikominLauncher.exe") (Join-Path $OutDir "PikominLauncher.exe")
  Pop-Location
}

@"
Pikomin Windows Portable
========================

How to run:
1) Open this folder
2) Double-click run.bat
3) Allow the Windows administrator permission prompt

Notes:
- Keep iPhone unlocked while running.
- Requires Apple drivers / iTunes components on Windows for device communication.
- Administrator permission is required to start pymobiledevice3 tunneld.
- The app opens at http://localhost:5679.
- run.bat starts tunneld and the app server in the background.
- Double-click stop.bat to stop Pikomin.
"@ | Out-File -Encoding utf8 (Join-Path $OutDir "README.txt")

Write-Host "[6/6] Create zip..."
$ZipPath = Join-Path $ProjectDir "release\pikomin-win-portable.zip"
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Optimize-PortableRuntime -VenvDir (Join-Path $OutDir "python")
Start-Sleep -Seconds 1
Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath $ZipPath

Write-Host "Done."
Write-Host "Portable folder: $OutDir"
Write-Host "Zip file: $ZipPath"
