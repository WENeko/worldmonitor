# directive-bridge — Hermès ⇄ Vibe-Trading closed loop

The operator-owned automation between a Hermès **directive** and its
**execution** in Vibe-Trading. It watches a shared directory for directive
JSON files written by Hermès, hands actionable ones to the Vibe-Trading
agent for execution (paper only), and writes an execution receipt back to
the same volume so Hermès can learn from the outcome — the feedback half of
the Macro Director loop.

## Why a bridge at all

- **Hermès never places orders.** Its core rules say so, and the upstream
  Vibe-Trading MCP server exposes **no order or cancel tools** by design
  (`agent/mcp_server.py` docstring at v0.1.14). The only execution surface
  is the internal agent runtime, which holds `trading_place_order` behind
  its mandate / pre-trade checks. The same applies to research: Hermès can
  *commission* read-only research through the bridge (`mode: RESEARCH`)
  instead of re-implementing indicator math itself — see
  `hermes-contract-v4.md` for the skill that makes that a habit.
- So the directive has to be handed to the agent. Doing that by hand every
  time (`docker exec vibe-trading vibe-trading -p "..." --json`) is the
  manual version of this bridge — fine for a one-off test, not a daily
  habit (two chiefs orchestrating the same stack).
- The bridge makes Hermès the **single daily interface** again: Hermès
  writes, the bridge executes, Hermès reads the receipt.

## How it works

```
Hermès (Macro Director)                    bridge container                  Vibe-Trading runtime (shared image + vibe_data)
        │                                        │                                     │
        │ writes /opt/data/bridge/directives/*.json       │                                     │
        ├──────────────────────────────────────►│  validate + safety gate                  │
        │                                        │  actionable? ──►  vibe-trading -p "…" --json   │
        │                                        │                       └──────────────► agent loop
        │                                        │                       ◄─────────────── trading_place_order (mandate-checked)
        │ reads /opt/data/bridge/executions/<id>.json   │  receipt (<id>.json + audits.jsonl)      │
        ◄───────────────────────────────────────┤                                     │
```

- **Transport**: no MCP, no Docker socket. The bridge container extends the
  local `vibe-trading:arm64` image and shares the `vibe_data` volume, so it
  runs the exact same `vibe-trading` CLI, connector profile
  (`alpaca-paper-trade`) and paper credentials. It invokes the headless
  single-run path: `vibe-trading -p <prompt> --json --max-iter N`.
- **Exchange volume** `bridge_data` is the ring buffer:
  - `/var/lib/bridge/directives` — owned by uid 1000 (Hermès's
    `HERMES_UID` default); Hermès drops directive JSON here.
  - `/var/lib/bridge/executions` — owned by the bridge runtime user
    (`vibe`, a system uid < 1000) and mode 0755 so Hermès (uid 1000) can
    read receipts back; one receipt JSON per `directive_id`, plus
    `audit/audits.jsonl`.
  - Hermès sees the same volume as `/opt/data/bridge` (mounted inside the
    hermes container). **Do not write to `~/.hermes/bridge/*` on the
    host**: that bind-mount directory is shadowed by the `bridge_data`
    volume at `/opt/data/bridge` and the bridge never sees it. Drop
    directives through a container (`docker cp` below) or from inside
    Hermès at `/opt/data/bridge/directives/`.

## Directive contract (what Hermès writes)

Drop a JSON file into `/opt/data/bridge/directives/` with the INTERFACE
CONTRACT fields. See `sample-directive.json`.

| Field | Required | Notes |
|---|---|---|
| `directive_id` | yes | Used as the idempotency key — one execution ever per id |
| `timestamp` | yes | ISO-8601 UTC |
| `target_asset` | yes | e.g. `SPY`, `AAPL` |
| `macro_bias` | yes | `BULLISH` / `BEARISH` / `NEUTRAL` |
| `confidence_score` | yes | 0..1 |
| `timeframe_hours` | yes | ≥ 0 |
| `action_directive` | yes | `INCREASE_LONG_SENSITIVITY` / `INCREASE_SHORT_SENSITIVITY` / `NO_ACTION` / `PAUSE_TRADING` / `DE_RISK` |
| `reasoning` | yes | free text |
| `mode` | no (default `PAPER`) | `PAPER` / `PAPER_SYNTHETIC_TEST` / `RESEARCH` — anything else is rejected |
| `execution_request` | no | For synthetic tests only: `{symbol, side, qty, order_type}` executed verbatim. **Forbidden in `RESEARCH` mode** |
| `research_question` | for `RESEARCH` mode | Free-text question the agent answers with read-only tools |
| `version` | no | schema version (currently 2) |

**Safety classification** (fail-closed, documented in `bridge.py`):

- `mode` ≠ PAPER / PAPER_SYNTHETIC_TEST / RESEARCH → `REJECTED`, never executed.
- `NO_ACTION` / `PAUSE_TRADING` / `DE_RISK` → recorded as `NO_EXECUTION`
  (auditable; DE_RISK position-reduction is a later version).
- Actionable directives → executed by the agent with its **own** mandate and
  fail-closed pre-trade checks (universe, size, exposure, daily cap). The
  bridge adds hard guardrails in the prompt: paper only, connector
  `alpaca-paper-trade`, max position size, no leverage, no options.
- `mode: RESEARCH` → **never executed against the broker**. It is a read-only
  research commission (quotes, bars, account state, indicator/evidence
  tools) with orders forbidden by prompt. Gated by `BRIDGE_ALLOW_RESEARCH`
  (default off): while the gate is closed the directive is recorded as
  `GATED` — a **parked, non-final receipt** that is re-processed
  automatically once the gate opens (no re-delivery needed). See
  `sample-directive-research.json`.
- Idempotent: a receipt already present for `directive_id` → skip (except
  `GATED`, which is not final).

## Receipts (what Hermès reads)

`/opt/data/bridge/executions/<directive_id>.json` contains
`status` (`EXECUTED` / `NO_EXECUTION` / `RESEARCH_DONE` /
`RESEARCH_TIMEOUT` / `RESEARCH_FAILED` / `GATED` / `REJECTED` / `FAILED` /
`TIMEOUT` / `DRY_RUN`), `processed_at`, `connector`, the agent's JSON result
(`run_id`, order, account/position state) and error tails. `audit/audits.jsonl`
is the append-only trail for backtesting the loop itself. The status
vocabulary is the *learning signal*: Hermès updates priors from
`RESEARCH_DONE` findings and `EXECUTED` outcomes (see
`hermes-contract-v4.md`).

## Operational runbook

```bash
cd ~/wm-stack && git pull --ff-only origin oci-trading-stack && cd deploy/oci
# bridge extends the locally built vibe-trading:arm64 image, so rebuild the
# base first when a stack Dockerfile changed (e.g. the alpaca-py install),
# then the bridge itself; `up -d` recreates both since the image ids moved:
docker compose build vibe-trading && docker compose build bridge
docker compose up -d vibe-trading bridge

# sanity + one-shot dry-run (no agent call). Both forms work:
#   - compose run applies the image ENTRYPOINT (python /app/bridge.py)
#   - docker exec IGNORES the ENTRYPOINT, so the interpreter must be explicit
docker compose run --rm bridge --check
docker exec bridge python /app/bridge.py --check --probe  # container up;
#   --probe additionally pings the LLM gateway through the same env the
#   agent uses and prints e.g. "probe: HTTP 200" (exit 1 unless 200)
docker compose run --rm -e BRIDGE_DRY_RUN=1 bridge --once

# synthetic end-to-end test (1 share AAPL, paper):
#   1) drop the sample into the exchange. From the HOST, copy into the
#      bridge container (same volume Hermès sees at /opt/data/bridge):
docker cp ~/wm-stack/deploy/oci/bridge/sample-directive-synthetic.json \
       bridge:/var/lib/bridge/directives/
#      (Hermès itself writes here as uid 1000: /opt/data/bridge/directives/)
#   2) watch the bridge process it (<= BRIDGE_POLL_S + agent run):
docker logs -f bridge
#   3) confirm the fill independently:
docker exec vibe-trading vibe-trading connector positions
#   4) read the receipt (bridge view == Hermès view of the same volume):
docker exec bridge cat /var/lib/bridge/executions/DIR-SYNTH-20260904-070100-001.json

# research commission (read-only, no order):
#   1) copy sample-directive-research.json into the exchange (as above)
#   2) default posture: gate closed → receipt status GATED (parked, non-final)
#   3) to run research, opt in and let the bridge re-process the parked file:
#      docker compose up -d bridge   # after exporting BRIDGE_ALLOW_RESEARCH=1
#   4) receipt status RESEARCH_DONE + findings in the agent JSON result
```

## Kill switch, dry run, env

| Var | Default | Meaning |
|---|---|---|
| `BRIDGE_HOME` | `/var/lib/bridge` | Exchange root |
| `BRIDGE_POLL_S` | `15` | Watch loop tick |
| `BRIDGE_MAX_ITER` | `30` | Agent iteration cap |
| `BRIDGE_TIMEOUT_S` | `900` | Agent subprocess timeout |
| `BRIDGE_CONNECTOR` | `alpaca-paper-trade` | Paper connector profile |
| `BRIDGE_MAX_QTY` | `3` | Soft per-order cap (embedded in the prompt) |
| `BRIDGE_DRY_RUN` | `0` | `1` logs the prompt, never invokes the agent |
| `BRIDGE_ALLOW_RESEARCH` | `0` | `1` lets `mode: RESEARCH` commissions run as read-only agent tasks |
| `BRIDGE_VIBE_TRADING_BIN` | `vibe-trading` | CLI binary path |

**Stand-down**: touching `/var/lib/bridge/halt` pauses processing until
removed. From the host (the volume has no host path — see above):

```bash
docker exec bridge touch /var/lib/bridge/halt   # stand down (runs as vibe)
```

Remove the file to resume (`docker exec bridge rm -f /var/lib/bridge/halt`).
Only the bridge runtime user (or root) can create it — Hermès's uid 1000
cannot write the volume root, which is intentional: stand-down is an
operator action.

## Resource posture (2 OCPU / 12 GB host)

The bridge is intentionally the *cheapest* container in the stack:

- **Idle**: a stdlib watcher (poll every 15 s) — ~50-100 MB RSS, ~0 CPU.
  No LLM stack is loaded until a directive actually arrives.
- **Busy**: processing one directive spawns the `vibe-trading` agent
  subprocess (bounded by `BRIDGE_MAX_ITER` = 30 and `BRIDGE_TIMEOUT_S` =
  900); the container's 1 GB memory ceiling covers that run.
- **Ceilings ≠ allocations**: `deploy.resources.limits` in
  `docker-compose.yml` caps what each container *may* use so the 12 GB
  host never OOMs a sibling — it does not change your OCI billing (that
  is fixed by the instance shape, 2 OCPU / 12 GB). Sum of all ceilings
  stays under ~12 GB; real idle usage is a few hundred MB total.
- **Verify live**: `docker stats --no-stream` shows actual per-container
  RSS. If you ever need the memory back, the leanest option is to drop the
  watch loop entirely and poll on cron instead:
  `docker compose run --rm bridge --once` (processes pending, exits).

## Troubleshooting

- **Receipt `FAILED` with `openai.OpenAIError: Missing credentials` in
  `stderr_tail`**: the bridge was created before `LITELLM_MASTER_KEY`
  existed in `deploy/oci/.env`, or `.env` changed without a recreate.
  Compose only injects values at container-create time, so a running
  container never sees a later `.env` edit. Recreate the LLM consumers
  (`docker compose up -d --build litellm vibe-trading bridge`) and re-drop
  the directive under a **fresh `directive_id`** — receipts are idempotent
  and a `FAILED` id never re-runs. `bridge --check` now prints the LLM env
  state (`llm_env: api_key=… base_url=…`) so this is visible in one call.
- **`bridge --check --probe` → `probe: HTTP 401` (or a body mentioning
  `Authentication Fails` / `Invalid API Key`)**: the gateway is healthy —
  the request reached LiteLLM's router — but the *provider* behind it
  rejects the credential. This is the upstream provider's 401 relayed by
  LiteLLM. Common cause: a placeholder value (`gsk_your_actual_key`) or no
  key at all for the configured provider. Each model group carries multiple
  deployments (Gemini primary + two Groq keys), so the fix is to set the
  real key(s) in `.env` (`GEMINI_API_KEY`, `GROQ_API_KEY`, `GROQ_API_KEY_2`
  — the second Groq key only adds capacity if it belongs to a *different*
  Groq org). Fix the value, `docker compose up -d litellm` (it reads config
  + env at startup; bridge and vibe-trading are unaffected), then re-run the
  probe.
- **`probe: HTTP 404` with a body mentioning `model_not_found`**: the model
  id in `litellm_config.yaml` no longer exists on Groq (Groq decommissioned
  the llama 3.3/3.1 line on 2026-08-16; both config ids were updated to the
  official replacements `openai/gpt-oss-120b` and `openai/gpt-oss-20b`).
  Check the live catalog with `curl -sS https://api.groq.com/openai/v1/models
  -H "Authorization: Bearer $GROQ_API_KEY"` before changing ids again.
- **`probe: HTTP 429` with `No deployments available… cooldown_list`**: the
  router marked the failing deployment(s) down after upstream errors. On
  Groq free tier this is a hard ceiling (~6k tokens/min per org): one large
  agent prompt exhausts the per-minute budget for ~200 s, and two keys from
  the same console share the ceiling. The 429 cools only its own deployment
  — with Gemini wired in (independent quota), the group falls through to it.
  A persistent 429 across *all* deployments means every configured key is
  throttled; `docker compose up -d --force-recreate litellm` resets
  cooldowns and a fresh `.env` key rotation is the real fix.
- **`docker exec bridge --check` → `executable file not found`**: `docker
  exec` ignores the image ENTRYPOINT; call the interpreter explicitly:
  `docker exec bridge python /app/bridge.py --check`.
- **`Connector positions failed: alpaca-py is not installed`** (from
  `vibe-trading` or inside a bridge agent run): the oci images install only
  the `vibe-trading-ai` core package — broker SDKs are separate pip
  packages. The retired standalone `~/trading-stack` quickstart image
  happened to carry alpaca-py; once that project was stopped, rebuilt oci
  images lost it. The repo fix lives in
  `deploy/oci/vibe-trading.Dockerfile` (a dedicated `pip install
  alpaca-py` RUN, inherited by bridge via `FROM vibe-trading:arm64`).
  After pulling, rebuild in order — `docker compose build vibe-trading &&
  docker compose build bridge && docker compose up -d vibe-trading bridge`
  — then verify with `docker exec vibe-trading vibe-trading connector check
  alpaca-paper-trade`. The connector profile and paper credentials live in
  the shared `vibe_data` volume, so they survive the rebuild.
- **`tee: … Permission denied` when dropping a directive**: `directives/` is
  owned by uid 1000 (Hermès) by design — the bridge container runs as
  `vibe` and may only *read* directives. Drop test directives from the host
  with `docker cp` (daemon-side copy, as in the runbook above), never
  `docker exec … tee`. Hermès writes there through its own container as uid
  1000.
- **`docker compose up` → `Container "/vibe-trading" is already in use`**:
  a leftover standalone `vibe-trading` container from the old
  `~/trading-stack` quickstart still holds the name. Retire that project
  once (`cd ~/trading-stack && docker compose down` — the `vibe_data`
  volume and the paper profile are kept), then bring the consolidated
  stack up from `deploy/oci`.

## Companion documents

- `hermes-contract-v4.md` — the paste-ready INTERFACE CONTRACT v4 for
  Hermès: adds the `read_receipts` and `commission_research` skills that
  turn the bridge receipts into the learning loop, plus the directive
  vocabulary (including `RESEARCH` mode) in one prompt.
- `sample-directive.json` / `sample-directive-synthetic.json` /
  `sample-directive-research.json` — the three directive shapes.

## Limits of this version (declare them)

- Execution is delegated to the agent's judgment within the prompt's
  guardrails; the bridge does not re-price or validate fills itself.
  `execution_request` is the deterministic path for tests.
- Research commissions are read-only by *prompt contract*, not by sandbox:
  the agent is trusted to stay out of order tools. Keep
  `BRIDGE_ALLOW_RESEARCH=0` unless you accept that trust boundary.
- No DE_RISK closing logic yet (recorded, not executed).
- The agent run is serialized (one directive at a time, per receipt lock).
- The base image must exist locally before `--build` runs:
  `vibe-trading:arm64` is produced by `docker compose up -d --build vibe-trading`.