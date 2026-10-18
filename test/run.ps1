param(
    [ValidateSet('all', 'backend', 'frontend')]
    [string]$Suite = 'all',
    [string]$Python = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $Python) {
    $taskLocalPython = Join-Path $taskRoot 'src/backend/.venv/Scripts/python.exe'
    if (Test-Path -LiteralPath $taskLocalPython) { $Python = $taskLocalPython }
    else { $Python = (Get-Command python -ErrorAction Stop).Source }
}
& $Python (Join-Path $PSScriptRoot 'run.py') --suite $Suite --python $Python
exit $LASTEXITCODE
