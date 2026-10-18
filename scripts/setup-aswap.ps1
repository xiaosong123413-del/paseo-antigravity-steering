param([switch]$SkipInstall)
$ErrorActionPreference = "Stop"
$base = Join-Path $env:LOCALAPPDATA "paseo-antigravity-steering\aswap"
$venv = Join-Path $base ".venv"
$exe = Join-Path $venv "Scripts\aswap.exe"
if (-not $SkipInstall) {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { throw "Python 3.10+ is required. Install Python and retry." }
    if (-not (Test-Path $venv)) {
        New-Item -ItemType Directory -Force $base | Out-Null
        & $py.Source -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw "Failed to create aswap virtual environment" }
    }
    & (Join-Path $venv "Scripts\python.exe") -m pip install --disable-pip-version-check "antigravity-swap==0.3.0"
    if ($LASTEXITCODE -ne 0) { throw "aswap installation failed" }
}
if (-not (Test-Path $exe)) { throw "aswap executable missing: $exe" }
Write-Host "aswap runtime ready:"
& $exe --version
Write-Host "Use aswap add to save accounts A and B after separate Google logins on this device."
Write-Host "Do not copy credentials between devices."
