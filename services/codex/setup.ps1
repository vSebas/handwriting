$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$uvExe = Join-Path $projectRoot '.tools\uv\uv.exe'
if (-not (Test-Path -LiteralPath $uvExe)) { $uvExe = (Get-Command uv -ErrorAction Stop).Source }
$env:UV_CACHE_DIR = Join-Path $projectRoot '.tools\uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot '.tools\python'
$venv = Join-Path $projectRoot '.tools\codex-venv'
$pythonExe = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    & $uvExe venv --python 3.11 $venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
}
& $pythonExe -c 'import PIL'
if ($LASTEXITCODE -ne 0) {
    & $uvExe pip install --python $pythonExe 'Pillow>=11,<13'
    if ($LASTEXITCODE -ne 0) { throw 'Pillow installation failed.' }
}
Write-Host 'Codex bridge installed. Sign in with codex login, then restart desktop Obsidian.'
