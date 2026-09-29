$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pythonExe = Join-Path $projectRoot '.tools\unimer-venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    throw 'Install UniMERNet with services\unimernet\setup.ps1 first.'
}
$env:HF_HOME = Join-Path $projectRoot '.tools\hf-cache'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
& $pythonExe (Join-Path $PSScriptRoot 'download_text_model.py') --model-dir (Join-Path $projectRoot '.tools\trocr-base-handwritten')
if ($LASTEXITCODE -ne 0) { throw 'TrOCR download failed; run setup-text.ps1 again to resume.' }
