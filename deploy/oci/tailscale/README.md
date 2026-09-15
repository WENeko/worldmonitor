# Tailnet access — the OCI host serves the operator UIs itself

`tailscale serve` turns the OCI host into the thing that publishes its own UIs.
No SSH tunnel, no terminal held open, no script on your laptop or phone, and no
change to the OCI ingress rules:

| UI | URL from any device on your tailnet |
|---|---|
| Vibe-Trading Web UI + REST API | `https://<node>.<tailnet>.ts.net/` |
| LiteLLM Admin UI | `https://<node>.<tailnet>.ts.net:8443/ui` |

TLS is a real, automatically renewed certificate for the `*.ts.net` name —
nothing to buy, nothing to renew, no domain to point anywhere. `--bg` mappings
resume by themselves after a reboot or a `tailscale up`.

## One command, on the OCI host

```bash
cd ~/wm-stack/deploy/oci
bash tailscale/setup-tailscale.sh            # configure + verify + write .env
```

| Flag | Effect |
|---|---|
| *(none)* | checks Tailscale, derives the MagicDNS name, writes `API_ALLOWED_HOSTS`, publishes both mappings, recreates `vibe-trading`, proves the HTTPS path |
| `--check` | report + probe only; changes nothing |
| `--dry-run` | print every change it would make |
| `--install` | install Tailscale first (`curl -fsSL https://tailscale.com/install.sh \| sh`) if it is missing |
| `--reset` | remove all `tailscale serve` mappings on this node |

Knobs: `VIBE_PORT` (8899), `LITELLM_PORT` (4000), `HTTPS_PORT` (443),
`HTTPS_LITELLM_PORT` (8443), `WAIT_S` (90), `ENV_FILE` (`../.env`).

Prerequisites, both in the Tailscale admin console → **DNS**: **MagicDNS** and
**HTTPS Certificates** enabled for the tailnet. The script names whichever of
the two is missing instead of failing opaquely.

## Why this is the right shape for Vibe-Trading

`tailscale serve` terminates TLS on the tailnet name and reverse proxies to
`http://127.0.0.1:8899`. The API therefore sees a **loopback peer** — exactly
the trust path an SSH tunnel uses. Two consequences:

- `VIBE_TRADING_API_AUTH_KEY` can stay **empty**: there is no shared bearer
  token to paste into the SPA, and non-loopback callers are still refused
  (`403 "API_AUTH_KEY is required for non-local API access"`).
- The loopback DNS-rebinding guard stays **active** in front of the UI, instead
  of becoming inert the way it does when a service listens publicly.

## The trap: why a *correct* proxy setup still gets 403

`tailscale serve` forwards the client's `Host` header **verbatim** to the
backend. The guard in `agent/src/api/security.py`
(`_reject_untrusted_loopback_host`) trusts a loopback *peer* — but it checks the
*Host* separately, and rejects anything that is neither loopback nor listed in
`API_ALLOWED_HOSTS`:

```text
GET https://node.tailnet.ts.net/  ->  403 {"detail": "Untrusted local API host"}
```

Everything else looks healthy in that state: container up, certificate valid,
`docker compose ps` green, `verify-ui.sh`'s loopback checks green, nothing in
the logs. The only fix is the hostname in the allow-list:

```bash
API_ALLOWED_HOSTS=node.tailnet.ts.net      # .env (comma-separated for several)
docker compose up -d vibe-trading          # docker-compose.yml passes it through
```

`setup-tailscale.sh` derives and writes that value, then proves the path with
its own HTTPS request — and `verify-ui.sh` re-checks it on every run, failing by
name on that 403 rather than leaving you with a blank page.

One asymmetry worth knowing: because the guard is inert for **non-loopback**
peers, pointing a browser straight at the tailnet IP
(`http://100.x.y.z:8899`, no `serve`) takes the *other* branch and demands
`VIBE_TRADING_API_AUTH_KEY`. Prefer `serve`: one config, TLS, and no key in the
browser.

## Everything else stays closed

Nothing is opened in the OCI ingress rules and no port is bound publicly:
`tailscale serve` listens on the Tailscale interface only, over WireGuard
(direct UDP 41641, or a DERP relay), and it dials out. Ports 8899/8900/4000/
8642/9119 stay loopback-only on the host, exactly as `setup.sh` requires.

Reaching it from a new device means installing the Tailscale app and logging
into your tailnet — that is the whole client-side story, and it is also what
makes the tailnet itself the authentication layer.

## Hardening, if you want more than "device on my tailnet"

- **Tailnet ACLs**: restrict who may reach `node:443` and `node:8443` in the
  Tailscale policy file. This is per-identity, unlike an IP allow-list, and it
  is enforced by the WireGuard peers themselves.
- **Do not use `tailscale funnel`** here. Funnel publishes to the *public*
  internet; that is the option-2 deployment (no TLS front end, bearer token in
  the browser) that this path exists to avoid.
- **LiteLLM admin** holds your provider keys. Tailnet-only access plus
  `UI_USERNAME`/`UI_PASSWORD` is a reasonable line; keep it out of any shared
  tailnet, or move it to a second node.
- Related: why the loopback guard exists at all is documented in
  `verify-ui.sh`'s header — the same Host check rejects the OCI public IP.

## Other ports (Hermès dashboard 9119, MCP 8642/8900)

One more mapping each, same shape:

```bash
sudo tailscale serve --bg --yes --https=9443 http://127.0.0.1:9119
```

MCP's HTTP transports additionally have their own allow-list
(`VIBE_TRADING_MCP_ALLOWED_HOSTS`) and stay loopback-only by default — add the
tailnet name there too if you proxy them.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 {"detail": "Untrusted local API host"}` | `API_ALLOWED_HOSTS` does not list the name in the URL. Rerun `setup-tailscale.sh`; check it also reached the container (`docker compose up -d vibe-trading`). |
| `403 "API_AUTH_KEY is required for non-local API access"` | the request did **not** take the 127.0.0.1 hop — the mapping targets something other than `http://127.0.0.1:8899`, or you opened the tailnet IP directly. |
| Browser cannot resolve `*.ts.net` | MagicDNS off for the tailnet, or Tailscale not running on that device. |
| Certificate warning / no cert | HTTPS Certificates off for the tailnet (admin console → DNS). `tailscale serve` fetches the cert on first use — the first request can take ~30 s. |
| `Connection refused` | `tailscale serve status` shows nothing, the mapping targeted the wrong port, or the container is down (`docker compose ps`). |
| Works on the laptop, not on the phone | Tailscale is installed and logged in on the laptop only — the app is the client, per device. |

Prefer the SSH tunnel instead? That is `../tunnel/` — same UIs, but it needs a
terminal (or the supervised service) on the machine with the browser.
