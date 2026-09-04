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
docker compose up -d --build bridge

# sanity + one-shot dry-run (no agent call):
docker compose run --rm bridge --check
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