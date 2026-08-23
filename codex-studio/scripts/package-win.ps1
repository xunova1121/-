$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Output = Join-Path $Root "dist/AI影视Studio"
dotnet publish "$Root/client/AI.FilmStudio/AI.FilmStudio.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o "$Output/client"
Copy-Item "$Root/server" "$Output/server" -Recurse -Force
Copy-Item "$Root/scripts/start-dev.ps1" "$Output/start.ps1" -Force
Write-Host "Package created: $Output"

