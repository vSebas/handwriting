param([switch]$Lan)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pythonExe = Join-Path $projectRoot '.tools\unimer-venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'Run the setup steps in services/unimernet/README.md first.' }
$listenAddress = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
& $pythonExe (Join-Path $PSScriptRoot 'server.py') --host $listenAddress --model-dir (Join-Path $projectRoot '.tools\unimernet-base') --token-file (Join-Path $projectRoot '.tools\unimernet-access-token.txt')
exit $LASTEXITCODE
