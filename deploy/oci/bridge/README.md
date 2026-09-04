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
  its mandate / pre-trade checks.
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
  - `/var/lib/bridge/executions` — owned by the bridge runtime user; one
    receipt JSON per `directive_id`, plus `audit/audits.jsonl`.
  - Hermès sees the same volume as `/opt/data/bridge`.

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
| `mode` | no (default `PAPER`) | `PAPER` or `PAPER_SYNTHETIC_TEST` — anything else is rejected |
| `execution_request` | no | For synthetic tests only: `{symbol, side, qty, order_type}` executed verbatim |
| `version` | no | schema version (currently 1) |

**Safety classification** (fail-closed, documented in `bridge.py`):

- `mode` ≠ PAPER / PAPER_SYNTHETIC_TEST → `REJECTED`, never executed.
- `NO_ACTION` / `PAUSE_TRADING` / `DE_RISK` → recorded as `NO_EXECUTION`
  (auditable; DE_RISK position-reduction is a later version).
- Actionable directives → executed by the agent with its **own** mandate and
  fail-closed pre-trade checks (universe, size, exposure, daily cap). The
  bridge adds hard guardrails in the prompt: paper only, connector
  `alpaca-paper-trade`, max position size, no leverage, no options.
- Idempotent: a receipt already present for `directive_id` → skip.

## Receipts (what Hermès reads)

`/opt/data/bridge/executions/<directive_id>.json` contains
`status` (`EXECUTED` / `NO_EXECUTION` / `REJECTED` / `FAILED` / `TIMEOUT` /
`DRY_RUN`), `processed_at`, `connector`, the agent's JSON result
(`run_id`, order, account/position state) and error tails. `audit/audits.jsonl`
is the append-only trail for backtesting the loop ourselves.

## Operational runbook

```bash
cd ~/wm-stack && git pull --ff-only origin oci-trading-stack && cd deploy/oci
docker compose up -d --build bridge

# sanity + one-shot dry-run (no agent call):
docker compose run --rm bridge --check
docker compose run --rm -e BRIDGE_DRY_RUN=1 bridge --once

# synthetic end-to-end test (1 share AAPL, paper):
#   1) Hermès (or you, in its data dir) copies sample-directive-synthetic.json
#      into the exchange:  ~/.hermes/bridge/directives/  (host view of /opt/data/bridge)
#   2) watch the bridge process it:
docker logs -f bridge
#   3) confirm the fill independently:
docker exec vibe-trading vibe-trading connector positions
#   4) Hermès reads /opt/data/bridge/executions/DIR-SYNTH-*.json
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
| `BRIDGE_VIBE_TRADING_BIN` | `vibe-trading` | CLI binary path |

**Stand-down**: touching `/var/lib/bridge/halt` (i.e.
`~/.hermes/bridge/halt` on the host) pauses processing until removed.

## Limits of this version (declare them)

- Execution is delegated to the agent's judgment within the prompt's
  guardrails; the bridge does not re-price or validate fills itself.
  `execution_request` is the deterministic path for tests.
- No DE_RISK closing logic yet (recorded, not executed).
- The agent run is serialized (one directive at a time, per receipt lock).
- The base image must exist locally before `--build` runs:
  `vibe-trading:arm64` is produced by `docker compose up -d --build vibe-trading`.