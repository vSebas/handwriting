$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$uvExe = Join-Path $projectRoot '.tools\uv\uv.exe'
if (-not (Test-Path -LiteralPath $uvExe)) { $uvExe = (Get-Command uv -ErrorAction Stop).Source }
$env:UV_CACHE_DIR = Join-Path $projectRoot '.tools\uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot '.tools\python'
$env:HF_HOME = Join-Path $projectRoot '.tools\hf-cache'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$venv = Join-Path $projectRoot '.tools\unimer-venv'
$pythonExe = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    & $uvExe venv --python 3.11 $venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
}
& $uvExe pip install --python $pythonExe torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $uvExe pip install --python $pythonExe -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'UniMERNet installation failed.' }
& $pythonExe (Join-Path $PSScriptRoot 'download_model.py') --model-dir (Join-Path $projectRoot '.tools\unimernet-base')
if ($LASTEXITCODE -ne 0) { throw 'Model download failed; run setup again to resume.' }
