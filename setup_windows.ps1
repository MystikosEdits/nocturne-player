# Nocturne setup for Windows: Python 3.13 venv + packages, the mpv player, Start menu / Desktop shortcuts.
# Run it from this folder:  right-click setup_windows.ps1 -> Run with PowerShell
#   (or:  powershell -ExecutionPolicy Bypass -File setup_windows.ps1)
# Safe to run again (it updates what's there).  -NoShortcuts skips the shortcuts, -NoLaunch doesn't open the app.
param([switch]$NoShortcuts, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Write-Host "Setting up Nocturne in $root" -ForegroundColor Cyan

# 1. Python 3.13 (the py launcher finds it; winget installs it if missing)
function Find-Python {
    foreach ($v in '3.13', '3.14') {
        try { $p = & py "-$v" -c "import sys; print(sys.executable)" 2>$null; if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() } } catch {}
    }
    return $null
}
$python = Find-Python
if (-not $python) {
    Write-Host "Installing Python 3.13 (winget)..." -ForegroundColor Yellow
    winget install -e --id Python.Python.3.13 --scope user --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $python = Find-Python
    if (-not $python) { throw "Python 3.13 didn't install. Get it from https://www.python.org/downloads/ (tick 'py launcher'), then run this again." }
}
Write-Host "Python: $python"

# 2. venv + packages (yt-dlp, ytmusicapi, pywebview, deno for YouTube's challenge, ...)
if (-not (Test-Path "$root\.venv\Scripts\python.exe")) { & $python -m venv "$root\.venv" }
$vpy = "$root\.venv\Scripts\python.exe"
& $vpy -m pip install --upgrade pip --quiet
& $vpy -m pip install -r "$root\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# 3. mpv (the audio engine): the official build from github.com/mpv-player/mpv
$mpvExe = "$root\bin\mpv\mpv.exe"
if (-not (Test-Path $mpvExe)) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
    $rel = Invoke-RestMethod 'https://api.github.com/repos/mpv-player/mpv/releases/latest' -Headers @{ 'User-Agent' = 'nocturne-setup' }
    $asset = $rel.assets | Where-Object { $_.name -match "^mpv-v[\d.]+-$arch-pc-windows-msvc\.zip$" } | Select-Object -First 1
    if (-not $asset) { throw "Couldn't find an mpv download for $arch" }
    Write-Host "Downloading $($asset.name)..."
    $zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip
    $tmp = Join-Path $env:TEMP "nocturne-mpv"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip $tmp
    $found = Get-ChildItem $tmp -Recurse -Filter mpv.exe | Select-Object -First 1
    New-Item -ItemType Directory -Force "$root\bin\mpv" | Out-Null
    Copy-Item (Join-Path $found.DirectoryName '*') "$root\bin\mpv" -Recurse -Force
    Remove-Item $zip, $tmp -Recurse -Force
}
Write-Host "mpv: $mpvExe"

# 4. Start menu + Desktop shortcuts (with the icon and app id, so Windows shows "Nocturne" in the media panel)
if (-not $NoShortcuts) { & $vpy "$root\tools\install_windows.py" }

Write-Host "`nDone. Open Nocturne from the Start menu or the Desktop." -ForegroundColor Green
if (-not $NoLaunch -and -not $NoShortcuts) { Start-Process "$root\.venv\Scripts\pythonw.exe" -ArgumentList "`"$root\run.py`"" -WorkingDirectory $root }
