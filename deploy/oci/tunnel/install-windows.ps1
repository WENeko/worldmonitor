<#
  install-windows.ps1 — register ocitunnel as a Scheduled Task at logon (Windows).

  Run on the machine that has the BROWSER (not on the OCI host):
    powershell -ExecutionPolicy Bypass -File install-windows.ps1 -SshHost ubuntu@130.61.235.29
    powershell -ExecutionPolicy Bypass -File install-windows.ps1 -SshHost ubuntu@130.61.235.29 -Identity ~\.ssh\id_ed25519
    powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall

  The task runs ocitunnel.ps1 hidden at every logon; the script itself reconnects
  forever, so a network drop, a sleep/wake cycle or an OCI reboot needs no action
  from you. If Register-ScheduledTask is refused, run PowerShell as Administrator.
#>
param(
  [string]$SshHost,
  [string]$Identity = '',
  [string]$Forwards = '8899:127.0.0.1:8899 4000:127.0.0.1:4000',
  [switch]$Uninstall,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$TaskName   = 'ocitunnel'
$BinDir     = Join-Path $env:USERPROFILE '.local\bin\ocitunnel'
$Bin        = Join-Path $BinDir 'ocitunnel.ps1'
$ConfigDir  = Join-Path $env:USERPROFILE '.config\ocitunnel'
$ConfigPath = Join-Path $ConfigDir 'config.json'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "  ok   scheduled task '$TaskName' removed (config and script kept)"
  exit 0
}

if (-not $SshHost) { Write-Host 'FAIL  -SshHost is required, e.g. -SshHost ubuntu@130.61.235.29' -ForegroundColor Red; exit 2 }
if ($SshHost -match '[<>]') { Write-Host 'FAIL  pass the real address, not the <oci-host> placeholder' -ForegroundColor Red; exit 2 }

$src = Join-Path $PSScriptRoot 'ocitunnel.ps1'
if (-not (Test-Path $src)) { Write-Host "FAIL  ocitunnel.ps1 not found next to this script ($src)" -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $BinDir, $ConfigDir | Out-Null
Copy-Item -Force $src $Bin
Write-Host "  ok   script: $Bin"

if ((Test-Path $ConfigPath) -and (-not $Force)) {
  Write-Host "  warn config kept: $ConfigPath (pass -Force to rewrite it)"
} else {
  [ordered]@{
    host       = $SshHost
    forwards   = $Forwards
    identity   = $Identity
    batchMode  = 'yes'
    backoffMin = 5
    backoffMax = 60
  } | ConvertTo-Json | Set-Content -Encoding UTF8 $ConfigPath
  Write-Host "  ok   config: $ConfigPath"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $Bin)
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'SSH tunnel to the Hermes stack UIs (Vibe-Trading :8899, LiteLLM :4000)' -Force | Out-Null
Write-Host "  ok   scheduled task '$TaskName' registered at logon"

Start-ScheduledTask -TaskName $TaskName
Write-Host '  ok   started'
Write-Host ''
Write-Host "  status:  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "  check:   powershell -ExecutionPolicy Bypass -File $Bin -Check"
Write-Host "  restart: Stop-ScheduledTask -TaskName $TaskName; Start-ScheduledTask -TaskName $TaskName"
Write-Host "  remove:  powershell -ExecutionPolicy Bypass -File $PSCommandPath -Uninstall"
