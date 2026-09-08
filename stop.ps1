# Stop the bridge hub + adapters.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $root -and ($_.CommandLine -match 'server\.js|file-bridge|hermes-adapter|hermes-gateway|worker') } |
  ForEach-Object {
    "stopping PID $($_.ProcessId) :: $($_.CommandLine)"
    Stop-Process -Id $_.ProcessId -Force
  }

Write-Host "[stop] bridge stopped."