# Tailnet access — the OCI host serves the operator UIs itself

`tailscale serve` turns the OCI host into the thing that publishes its own UIs.
No SSH tunnel, no terminal held open, no script on your laptop or phone, and no
change to the OCI ingress rules:

| UI | URL from any device on your tailnet |
|---|---|
| Vibe-Trading Web UI + REST API | `https://<node>.<tailnet>.ts.net/` |
| LiteLLM Admin UI | `https://<node>.<tailnet>.ts.net:8443/ui` |
| Hermès dashboard | `https://<node>.<tailnet>.ts.net:9443/` |

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

Knobs: `VIBE_PORT` (8899), `LITELLM_PORT` (4000), `HERMES_PORT` (9119),
`HTTPS_PORT` (443), `HTTPS_LITELLM_PORT` (8443), `HTTPS_HERMES_PORT` (9443),
`WAIT_S` (90), `ENV_FILE` (`../.env`).

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

## The Hermès dashboard (`:9119`) — mapping is not enough

Published by the same command, on its own HTTPS port:

```text
https://<node>.<tailnet>.ts.net:9443/   ->   http://127.0.0.1:9119
```

But the mapping alone returns

```text
HTTP 400 {"detail":"Invalid Host header. Dashboard requests must use the bound
hostname or the configured public hostname."}
```

`tailscale serve` forwards the browser's `Host` verbatim, and the dashboard
validates it (`hermes_cli/web_server.py`, `host_header_middleware`, GHSA-ppp5-vxwm-4cf7 — the
same DNS-rebinding defence that produces Vibe-Trading's `API_ALLOWED_HOSTS` 403,
one layer up). It accepts only the bound hostname or the hostname declared in
`dashboard.public_url` (`HERMES_DASHBOARD_PUBLIC_URL` wins over config.yaml).

Declaring that URL is **not free**: a non-loopback public URL also engages the
dashboard's auth gate, and the gate **fails closed** — with no provider
registered the dashboard refuses to bind at all rather than serve unauthenticated
(that hardening followed the June 2026 `HERMES_DASHBOARD_INSECURE` campaign). So,
order matters, and the script enforces it:

1. Put the bundled password provider in `.env` (no external IDP):

   ```bash
   HERMES_DASHBOARD_BASIC_AUTH_USERNAME=<user>
   HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<password>
   # optional: sessions survive a restart instead of a per-process signing key
   HERMES_DASHBOARD_BASIC_AUTH_SECRET=<random>
   ```

2. Rerun `bash tailscale/setup-tailscale.sh`. It writes
   `HERMES_DASHBOARD_PUBLIC_URL=$(url_for_port 9443)` into `.env` and recreates
   `hermes` (which restarts the agent). Without both credentials it **refuses to
   write** the URL and says so — that is deliberate, not a bug.

3. Open `https://<node>.<tailnet>.ts.net:9443/` and sign in with the pair above.

**The same thing without touching `.env`** — the route that works on a checkout
predating the compose pass-through. Write the three values into the Hermes config
instead, always through the container's shim:

```bash
H=/opt/hermes/bin/hermes          # shim: drops to the `hermes` user, exports HOME=/opt/data
U='<user>'; P='<password>'

docker exec hermes $H config path                                   # -> /opt/data/config.yaml
docker exec hermes $H config set dashboard.basic_auth.username "$U" # provider FIRST
docker exec hermes $H config set dashboard.basic_auth.password "$P"
docker exec hermes $H config set dashboard.public_url "https://$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.*".*/\1/p' | head -1).ts.net:9443"

docker restart hermes             # a config change needs a service restart
```

**Signing in with your Nous Portal account instead** (the one created through
GitHub SSO): the bundled `nous` provider is OAuth, so nothing local to remember —
but it needs a registered OAuth client first. `hermes login` is deprecated and
prints only a notice, so add the credential with the modern command:

```bash
H=/opt/hermes/bin/hermes
docker exec hermes $H auth add nous --no-browser   # device code: prints a URL to open on any device
docker exec hermes $H auth status nous
docker exec hermes $H dashboard register \
  --redirect-uri https://<node>.<tailnet>.ts.net:9443/auth/callback
docker restart hermes
```

`--redirect-uri` is not optional for a tailnet deployment: omitting it registers a
localhost-only client, and the path must end exactly in `/auth/callback` (the
bundled providers reject anything else). Registration writes
`HERMES_DASHBOARD_OAUTH_CLIENT_ID` into the Hermes environment file; after the
restart the login page offers a **Nous Research** button, and GitHub SSO happens on
the portal side. Both providers can stay registered — the page shows the password
form and the OAuth button.

The client id must have the shape `agent:{instance_id}`, which the portal applies
server-side. Any other value makes the bundled provider **skip registration with a
warning only** — the process starts, the page loads, and the button is simply
absent. One check decides, and it is what the page itself fetches:

```bash
curl -sS http://127.0.0.1:9119/api/auth/providers
```

`nous` in that list = done. `nous` missing is one of three things — and
`hermes config get dashboard.oauth.client_id` **cannot tell them apart**:
`dashboard register` writes the id to the Hermes *environment file*
(`/opt/data/.env`), not to `config.yaml`, and env wins over config
(`plugins/dashboard_auth/_shared.py`, `resolve_env_or_cfg`; an empty env value
counts as unset). A blank `config get` therefore proves nothing.

| Symptom | Where to look |
|---|---|
| registration never succeeded | re-run `dashboard register` and read its own output (e.g. "You're not logged into Nous Portal") |
| id written without the `agent:` prefix | `docker exec hermes sh -c 'grep HERMES_DASHBOARD_OAUTH_CLIENT_ID /opt/data/.env'` |
| id right, provider still absent | the dashboard was not restarted — registration happens at startup |

`dashboard register` also writes `HERMES_DASHBOARD_PUBLIC_URL` itself. Declaring
the same variable in the host `.env` is not an error, but it is a second source of
truth for one value, and the compose-injected variable **wins** over the
container's own env file. Pick one owner: either the host `.env` (this script,
step 2 above — which needs the password pair as its precondition) or
`dashboard register` (the OAuth route, no precondition). Rotate or revoke the
client any time at <https://portal.nousresearch.com/local-dashboards>.

Three traps, all observed in the field:

- **`sh -lc` breaks it.** A *login* shell rebuilds `PATH` and loses
  `/opt/hermes/bin`, so you get `hermes: not found`. Use the absolute path, or a
  plain `sh -c`.
- **Bare `<placeholder>` breaks it.** `sh` reads `<` as a redirection
  (`Syntax error: end of file unexpected`) — substitute real values into a
  variable, as above.
- **`docker compose up -d hermes` does nothing here.** With `.env` and the
  compose file unchanged it prints `Container hermes Running` and leaves the
  process alone, so the dashboard never re-reads the config. `docker restart
  hermes` is the deterministic one; session history lives under `/opt/data`, so
  nothing is lost.

The probe reports which of the three states you are in: `200` (dashboard or its
login page), the `400 Invalid Host header` above, `401`/`403` (signed out), or
nothing answering locally either — meaning `HERMES_DASHBOARD=1` is not in effect
for the running container (`docker compose up -d hermes`).

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
| Hermès `:9443` answers `400 "Invalid Host header"` | the dashboard rejects a Host it was not told about. Add `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` + `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` to `.env`, rerun `setup-tailscale.sh` (it writes `HERMES_DASHBOARD_PUBLIC_URL` and recreates `hermes`). |
| Hermès dashboard logs `Refusing to bind dashboard to …` | `HERMES_DASHBOARD_PUBLIC_URL` was set without an auth provider — a non-loopback public URL always requires one. Set the basic pair, then `docker compose up -d hermes`. |

Prefer the SSH tunnel instead? That is `../tunnel/` — same UIs, but it needs a
terminal (or the supervised service) on the machine with the browser.
