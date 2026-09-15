<#
  ocitunnel.ps1 — supervised SSH tunnel to the Hermes stack UIs (Windows).

  Counterpart of ocitunnel.sh. install-windows.ps1 copies this file and
  registers it as a Scheduled Task at logon, so you normally never run it by
  hand. Flags, mirroring the shell script:

    -Check   prerequisites + reachability, then exit (0 ok, 1 failed)
    -Once    one foreground ssh, no reconnect

  Config: %USERPROFILE%\.config\ocitunnel\config.json
    {
      "host":       "ubuntu@130.61.235.29",
      "forwards":   "8899:127.0.0.1:8899 4000:127.0.0.1:4000",
      "identity":   "",
      "batchMode":  "yes",
      "backoffMin": 5,
      "backoffMax": 60
    }
#>
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\ocitunnel\config.json'),
  [switch]$Check,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'

function Write-Ok   ($m) { Write-Host "  ok   $m" }
function Write-Warn ($m) { Write-Host "  warn $m" }
function Fail       ($m) { Write-Host "FAIL  $m" -ForegroundColor Red; exit 1 }
function Write-Log  ($m) { Write-Host ("{0} [ocitunnel] {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $m) }

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Fail 'ssh is not on PATH (install the Windows OpenSSH client)' }
if (-not (Test-Path $ConfigPath)) { Fail "no config at $ConfigPath — run install-windows.ps1 first" }

$cfg           = Get-Content -Raw $ConfigPath | ConvertFrom-Json
$sshHost       = $cfg.host
$forwards      = $cfg.forwards
$identity      = $cfg.identity
$batchMode     = if ($cfg.batchMode) { $cfg.batchMode } else { 'yes' }
$backoffMin    = if ($cfg.backoffMin) { [int]$cfg.backoffMin } else { 5 }
$backoffMax    = if ($cfg.backoffMax) { [int]$cfg.backoffMax } else { 60 }

if (-not $sshHost) { Fail "config has no 'host' key ($ConfigPath)" }
if ($sshHost -match '[<>]') { Fail "config 'host' is still a placeholder ('$sshHost'): put the real user@host in $ConfigPath" }
if (-not $forwards) { Fail "config has no 'forwards' key ($ConfigPath)" }

$baseArgs = @(
  '-o','ServerAliveInterval=30',
  '-o','ServerAliveCountMax=3',
  '-o','ExitOnForwardFailure=yes',
  '-o','TCPKeepAlive=yes',
  '-o','ConnectTimeout=15',
  '-o',"BatchMode=$batchMode"
)
if ($identity) { $baseArgs += @('-i', $identity) }

$forwardArgs = @()
foreach ($fwd in $forwards.Split(' ')) {
  if ($fwd -notmatch '^[^:]+:[^:]+:[^:]+$') { Fail "malformed forward '$fwd' (expected LOCAL_PORT:127.0.0.1:REMOTE_PORT)" }
  $forwardArgs += @('-L', $fwd)
}
if ($forwardArgs.Count -eq 0) { Fail "no usable forward in '$forwards'" }

# ---------------------------------------------------------------------------
# -Check
# ---------------------------------------------------------------------------
if ($Check) {
  Write-Host 'ocitunnel prerequisites'
  Write-Ok "config file: $ConfigPath"
  Write-Ok "target: $sshHost"
  Write-Ok "forwards: $forwards"
  $autossh = Get-Command autossh -ErrorAction SilentlyContinue
  if ($autossh) { Write-Ok 'autossh present' }
  else { Write-Warn 'autossh not installed: this script supervises ssh itself (recovery waits for ServerAlive to time out, ~90s)' }

  foreach ($fwd in $forwards.Split(' ')) {
    $port = [int]($fwd.Split(':')[0])
    $busy = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if ($busy) { Write-Warn "local port $port already has a listener: either ocitunnel is already running (fine) or another process holds it (the tunnel will refuse to bind)" }
    else       { Write-Ok   "local port $port free" }
  }

  $probe = & ssh @baseArgs $sshHost 'true' 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "ssh login works without a prompt (key auth): $sshHost"
  } else {
    Write-Warn "ssh probe failed: $probe"
    Write-Host '       If that says "Permission denied (publickey)", this machine has no key for that host yet.'
    Write-Host '       An unattended tunnel cannot answer a password prompt.'
    exit 1
  }
  Write-Host ''
  Write-Host '  Vibe-Trading Web UI: http://127.0.0.1:8899'
  Write-Host '  LiteLLM Admin UI:    http://127.0.0.1:4000/ui  (admin + LITELLM_MASTER_KEY)'
  Write-Host '  Use 127.0.0.1 (or localhost), never the OCI public IP: a non-loopback Host header'
  Write-Host '  is rejected with 403 "Untrusted local API host".'
  exit 0
}

# ---------------------------------------------------------------------------
# Run / -Once
# ---------------------------------------------------------------------------
$sshArgs = @('-N') + $baseArgs + $forwardArgs + @($sshHost)

function Invoke-Tunnel {
  if (Get-Command autossh -ErrorAction SilentlyContinue) {
    $env:AUTOSSH_GATETIME = '0'
    & autossh '-M' '0' @sshArgs
  } else {
    & ssh @sshArgs
  }
}

if ($Once) {
  Write-Log "connecting once: $sshHost <- $forwards"
  Invoke-Tunnel
  $rc = $LASTEXITCODE
  Write-Log "exited rc=$rc (-Once: not reconnecting)"
  exit $rc
}

$attempt = 0
$backoff = $backoffMin
while ($true) {
  $attempt++
  $started = Get-Date
  Write-Log "connecting (attempt $attempt) <- $forwards"
  Invoke-Tunnel
  $rc = $LASTEXITCODE
  $lived = [int]((Get-Date) - $started).TotalSeconds
  Write-Log "tunnel exited rc=$rc after ${lived}s"
  if ($lived -ge 60) { $backoff = $backoffMin }
  else { $backoff = [Math]::Min($backoff * 2, $backoffMax) }
  Write-Log "retrying in ${backoff}s"
  Start-Sleep -Seconds $backoff
}
