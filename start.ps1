# Start the bridge hub + file-bridge + harvester adapters together.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# load .env if present
if (Test-Path "$root\.env") {
  Get-Content "$root\.env" | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object {
    $kv = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($kv[0].Trim(), $kv[1].Trim(), 'Process')
  }
}

# node binary: BRIDGE_NODE env override, then PATH, then a known fallback.
$node = $env:BRIDGE_NODE
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { $node = 'C:\Users\User\tools\node\node.exe' }

function Start-Bg($name, $scriptPath) {
  Write-Host "[start] $name -> $scriptPath" -ForegroundColor Cyan
  Start-Process -FilePath $node `
    -ArgumentList @('"' + $scriptPath + '"') -WindowStyle Hidden -RedirectStandardOutput "$root\logs\$name.log" `
    -RedirectStandardError "$root\logs\$name.err.log"
}

New-Item -ItemType Directory -Force "$root\logs" | Out-Null

# clean old logs
Remove-Item "$root\logs\*" -Force -Recurse -ErrorAction SilentlyContinue

Start-Process -FilePath $node -ArgumentList @('"' + "$root\hub\server.js" + '"') -WindowStyle Hidden `
  -RedirectStandardOutput "$root\logs\hub.log" -RedirectStandardError "$root\logs\hub.err.log"
Write-Host "[start] hub -> hub/server.js" -ForegroundColor Cyan

Start-Sleep -Milliseconds 800
Start-Bg 'filebridge' "$root\adapters\file-bridge.js"
Start-Bg 'hermes'     "$root\adapters\hermes-adapter.js"
Start-Bg 'worker'     "$root\adapters\worker.js"
Start-Bg 'hermes-gw'  "$root\mcp\hermes-gateway.mjs"

Write-Host "[start] bridge is up. logs in $root\logs"
Write-Host "[start] try:  $node bin\bridge.js list"
