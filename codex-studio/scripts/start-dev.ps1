$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server"
$Client = Join-Path $Root "client/AI.FilmStudio"

if (-not (Test-Path "$Server/.venv")) { python -m venv "$Server/.venv" }
& "$Server/.venv/Scripts/pip.exe" install -r "$Server/requirements.txt"
Start-Process -FilePath "$Server/.venv/Scripts/python.exe" -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "18118" -WorkingDirectory $Server
Start-Sleep -Seconds 2
dotnet run --project "$Client/AI.FilmStudio.csproj"

