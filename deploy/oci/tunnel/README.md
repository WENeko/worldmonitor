# ocitunnel — the operator UIs without a terminal left open

> **Try `../tailscale/` first.** `tailscale serve` makes the OCI host publish
> both UIs to your tailnet itself (`https://<node>.<tailnet>.ts.net`, real TLS
> certificate, nothing opened in the OCI ingress rules) — no tunnel and no
> client-side script on any device. Use this directory when a tailnet is not an
> option, or as a fallback in front of a host where `serve` cannot be set up.

The stack binds its two UIs to **loopback on the OCI host** (`:8899`
Vibe-Trading, `:4000` LiteLLM) and the OCI ingress rules keep those ports
closed. Reaching them from a browser therefore requires an SSH tunnel:

```bash
ssh -N -L 8899:127.0.0.1:8899 -L 4000:127.0.0.1:4000 ubuntu@<oci-host>
```

That works until it doesn't. A bare `ssh` dies on laptop sleep, a Wi-Fi change,
a NAT timeout or an OCI reboot, and nothing brings it back — the UI just looks
broken, with no error anywhere. This directory is that command turned into a
**service**: `ocitunnel.sh` is the same tunnel inside a reconnect loop, and
`install.sh` / `install-windows.ps1` register it with the platform's own
supervisor so it comes back on every login, reboot and network drop.

Run it on **the machine with the browser**, never on the OCI host. Installing it
on the host puts the UI inside a remote shell, where no browser can see it.

| File | Platform | Role |
|---|---|---|
| `ocitunnel.sh` | Linux / macOS / WSL | the tunnel + reconnect loop (single source of truth) |
| `install.sh` | Linux (systemd user unit), macOS (LaunchAgent) | copies the script, writes the config, enables it |
| `ocitunnel.ps1` | Windows | PowerShell counterpart of `ocitunnel.sh` |
| `install-windows.ps1` | Windows | writes the config, registers a Scheduled Task at logon |

## Install

This directory belongs on the machine with the browser, which is usually not the
checkout on the OCI host. Copy it over once:

```bash
scp -r ubuntu@<oci-host>:~/wm-stack/deploy/oci/tunnel ~/ocitunnel
cd ~/ocitunnel
```

**Linux / macOS** — on your machine, with the browser:

```bash
bash install.sh ubuntu@130.61.235.29                    # key from your ssh config
bash install.sh ubuntu@130.61.235.29 ~/.ssh/id_ed25519  # explicit key
bash install.sh --uninstall
```

Running it inside an SSH session (the mistake that puts the tunnel on the host)
asks first and explains why. Afterwards:

```bash
systemctl --user status ocitunnel      # Linux
journalctl --user -u ocitunnel -f      # Linux logs
launchctl print gui/$(id -u)/com.worldmonitor.ocitunnel   # macOS
tail -f ~/Library/Logs/ocitunnel.log                      # macOS logs
```

On Linux the unit is a **user** unit: it starts at login, and needs
`sudo loginctl enable-linger $USER` to also start at boot with nobody logged in.

**Windows** — in PowerShell, on your machine:

```powershell
powershell -ExecutionPolicy Bypass -File install-windows.ps1 -SshHost ubuntu@130.61.235.29
powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall
```

Windows needs the OpenSSH client (`Add-WindowsCapability -Online -Name
OpenSSH.Client~~~~0.0.1.0`) and a key; an unattended tunnel cannot answer a
password prompt.

## Verify

```bash
bash ~/.local/bin/ocitunnel/ocitunnel.sh --check   # prerequisites + ssh reachability
curl -sS -o /dev/null -w 'vibe-trading: %{http_code}\n' http://127.0.0.1:8899/
curl -sS -o /dev/null -w 'litellm ui:    %{http_code}\n' -L http://127.0.0.1:4000/ui
```

Two `200`s mean the tunnel is up; open <http://127.0.0.1:8899> and
<http://127.0.0.1:4000/ui> (login `UI_USERNAME` + `UI_PASSWORD` from `.env`;
see the LiteLLM section of `../env.template` for why the master key alone is
not a reliable fallback).

`--check` is a gate (exit 1 on failure) but is deliberately **not** wired as
`ExecStartPre`: a transient outage at boot would then mark the unit failed
instead of letting the retry loop do its job.

### A dead tunnel exits immediately instead of hanging

`ExitOnForwardFailure=yes` makes that visible in one case worth knowing: if a
local port is already taken (a leftover manual `ssh -L 8899:...` in another
terminal, say), `ssh` exits right away and the loop backs off — it does not
silently bind nothing. `--check` reports a busy port as a warning.

## Configuration

`~/.config/ocitunnel/config` (Linux/macOS, shell syntax) or
`%USERPROFILE%\.config\ocitunnel\config.json` (Windows). Environment variables
of the same names win over the file, for one-off runs.

| Setting | Default | Notes |
|---|---|---|
| `OCITUNNEL_HOST` | — | required, `user@host`; a `<oci-host>` placeholder fails fast |
| `OCITUNNEL_FORWARDS` | `8899:127.0.0.1:8899 4000:127.0.0.1:4000` | whitespace-separated `-L` specs |
| `OCITUNNEL_IDENTITY` | empty | passed as `-i` |
| `OCITUNNEL_SSH_OPTS` | empty | extra ssh options, e.g. `-o ProxyJump=bastion` |
| `OCITUNNEL_BATCHMODE` | `yes` | unattended runs never prompt; a key is required |
| `OCITUNNEL_BACKOFF_MIN` / `MAX` | `5` / `60` | reconnect backoff, doubled until `MAX` and reset after a connection that lived ≥ 60 s |

`ocitunnel.sh --print` shows the exact command being run, and `--once` runs it
in the foreground — the same code path the service uses.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 Untrusted local API host` | you opened the **OCI public IP**. The anti-DNS-rebinding middleware only accepts loopback `Host` headers — use `127.0.0.1` or `localhost` through the tunnel. |
| `Connection refused` on `127.0.0.1:8899` | tunnel down (check the service), or the container is not serving the SPA — see `../verify-ui.sh`. |
| `Permission denied (publickey)` | no key for the host on this machine: `ssh-copy-id <host>`, or set `OCITUNNEL_IDENTITY`. |
| Log shows `exited rc=255 after 0s` over and over | port already bound (see above), DNS/network down, or wrong `OCITUNNEL_HOST`. |
| UI answers JSON instead of a page | the SPA was not built into the image: `bash ../verify-ui.sh` on the host names the failing check. |

## Scope (what this deliberately does not do)

- **No OCI ingress change.** Ports 8899/8900/4000/8642/9119 stay closed
  publicly; the tunnel is the only path, and `env.template`
  ("Operator UI access") explains why.
- **No bearer token.** A tunnel arrives from `127.0.0.1`, so the UIs need no key
  while `VIBE_TRADING_API_AUTH_KEY` stays empty. Do not set it just to use the
  UI: it makes *every* request, browser included, carry a token.
- **No remote browser.** Only the machine running this service can use the UIs.
  Reaching them from a phone needs a TLS reverse proxy plus an auth key — a
  different change, not a config tweak.
