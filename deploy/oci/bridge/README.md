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
  `hermes-contract.md` for the skill that makes that a habit.
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
  `alpaca-paper-trade`, max position size, no leverage, no margin, no
  options, and fractional quantities allowed **wherever the broker supports
  them** (crypto, fractional shares, forex units) so orders can be sized
  *under* the caps instead of rounding up to a whole unit.
- `mode: RESEARCH` → **never executed against the broker**. It is a read-only
  research commission (quotes, bars, account state, indicator/evidence
  tools) with orders forbidden by prompt. Gated by `BRIDGE_ALLOW_RESEARCH`
  (default off): while the gate is closed the directive is recorded as
  `GATED` — a **parked, non-final receipt** that is re-processed
  automatically once the gate opens (no re-delivery needed). See
  `sample-directive-research.json`.
- Idempotent: a receipt already present for `directive_id` → skip (except
  `GATED`, which is not final). The skip is logged at INFO **once per process**
  and at DEBUG afterwards, and `--archive` clears the file out of the inbox —
  see "Inbox tidiness" below.

## Receipts (what Hermès reads)

`/opt/data/bridge/executions/<directive_id>.json` contains
`status` (`EXECUTED` / `NO_EXECUTION` / `RESEARCH_DONE` /
`RESEARCH_TIMEOUT` / `RESEARCH_FAILED` / `GATED` / `REJECTED` / `FAILED` /
`TIMEOUT` / `DRY_RUN`), `processed_at`, `connector`, the agent's JSON result
(`run_id`, order, account/position state) and error tails. For directives
that carry an `execution_request`, the receipt also includes a
`fill_verification` block (connector positions before/after the run). A
`FAILED` status with reason `order_not_filled` means the agent finished
successfully but the mandated order did not land; `partial_fill` means
something landed, short of the mandate. The bridge no longer trusts the
agent's exit code alone for mandated orders. The block always carries the
exact before → after delta and names the broker row it matched
(`[broker row 'BTCUSD']`), so a spelling difference between the directive
symbol and the venue's row is visible instead of looking like a missing
fill. A failed fill check additionally carries `run_evidence` — the failing
run's own `state.json` and its rejected tool calls, copied from the run
directory before it can be rotated away (see "What proves a directive was
really executed"). `audit/audits.jsonl`
is the append-only trail for backtesting the loop itself. The status
vocabulary is the *learning signal*: Hermès updates priors from
`RESEARCH_DONE` findings and `EXECUTED` outcomes (see
`hermes-contract.md`).

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
#   5) RE-RUNNING THE SAME SAMPLE IS A SILENT NO-OP. The receipt is the
#      idempotence key: `process_file` skips any directive_id that already has
#      one, whatever its status — DIR-SYNTH-20260904-070100-001's receipt is
#      FAILED (2026-09-04) and dropping the file again would only print an
#      `already processed; skipping` line. Renaming the FILE does not help
#      either: the lookup is on the id inside it, never the filename (see
#      "Inbox tidiness"). Give the copy a fresh inner "directive_id" — or move
#      the old receipt aside first — then it runs for real.

# research commission (read-only, no order):
#   1) copy sample-directive-research.json into the exchange (as above)
#   2) default posture: gate closed → receipt status GATED (parked, non-final)
#   3) to run research, opt in and let the bridge re-process the parked file:
#      docker compose up -d bridge   # after exporting BRIDGE_ALLOW_RESEARCH=1
#   4) receipt status RESEARCH_DONE + findings in the agent JSON result
```

## Inbox tidiness — archiving processed directives

`directives/` is a ring buffer, not a log: a file whose receipt already exists
is skipped forever, and the bridge can only *say* so. Six parked files meant six
`already processed; skipping` lines per 15 s tick — ~34 000 lines a day, which is
where a first real directive goes to die. Two independent fixes are in place:

- **In the watcher** (`bridge.py`): the first skip of a given `directive_id` is
  logged at INFO, every later one at DEBUG. `BRIDGE_LOG_LEVEL=DEBUG` shows them
  all again when you are actually debugging idempotency.
- **At the source**: `--archive` moves the processed files out of the watched
  directory.

The bridge runs as `vibe` and `directives/` is owned by Hermès's uid 1000 on
purpose (the bridge may only *read* directives), so archiving has to run as root
**inside the container**:

```bash
docker compose build bridge && docker compose up -d bridge   # picks up bridge.py
docker exec -u 0 bridge python /app/bridge.py --archive --check   # report only
docker exec -u 0 bridge python /app/bridge.py --archive
```

Rules it follows:

- A directive is archived when its receipt exists with any status **except**
  `GATED` — exactly the set `process_file` skips forever. A `GATED` receipt is
  parked and non-final, so its directive **stays** in the watched directory for
  the bridge to re-process when `BRIDGE_ALLOW_RESEARCH=1`.
- The receipt is located by the id **inside** the directive file, never by its
  filename — the same key the watcher itself uses. A directive dropped under an
  operator-chosen name (`sample-directive-synthetic.json`, whose inner id is
  `DIR-SYNTH-…`) therefore archives like any other. Keying on the filename left
  exactly that file in the inbox forever: processed by the bridge, invisible to
  `--archive` — the one case the operator is most likely to create by hand.
- A directive with **no** receipt is pending, not processed: never touched, and
  now counted as `pending` in the summary so a silent inbox cannot hide a file.
- A directive with an **unreadable** receipt is never touched and is reported as
  `FAILED` with a non-zero exit — the bridge cannot read that receipt either, so
  it treats the directive as never processed and will re-execute it.
- Receipts are never moved. They remain the idempotency key and the input to
  Hermès's daily learning review; archiving a directive file changes nothing but
  the log volume (`directives/archive/` is not watched).

## First real directive — acceptance

The loop is closed when a directive **Hermès wrote** has a receipt. The
`DIR-SYNTH-*` files are operator-made samples: they prove the bridge executes an
order, not that Hermès *delivers* one (règle 8 — delivery is the file appearing
in `/opt/data/bridge/directives/`).

```bash
# 1. in the Hermès dashboard, ask for one cycle, e.g.
#    "Run one decision cycle and deliver your directive through the bridge"
# 2. watch the inbox and the watcher (règle 10: read state → decide → write
#    directive file → wait for receipt)
docker exec bridge sh -c 'ls -la /var/lib/bridge/directives/ | grep -v archive'
docker logs --tail=20 bridge
# 3. the proof: a receipt whose id is not a sample, and its agent run id
docker exec bridge sh -c 'ls -lt /var/lib/bridge/executions/*.json | head -3'
# the newest receipt, without retyping its id. A `<directive_id>` placeholder in
# a shell command is a REDIRECTION, not a hole to fill in
# (`-bash: directive_id: No such file or directory`) -- let the shell pick it:
docker exec bridge sh -c 'cat "$(ls -t /var/lib/bridge/executions/*.json | head -1)"'
```

Accept it when the receipt carries a **terminal** status — `EXECUTED`,
`NO_EXECUTION`, `RESEARCH_DONE`, `RESEARCH_TIMEOUT`, `RESEARCH_FAILED`,
`REJECTED`, `FAILED` or `TIMEOUT` — and a `run_id` under `agent_result` for
everything that reached the agent. `GATED` is **not** acceptance: it is parked.

### What proves a directive was really executed

For a directive that requests an exposure change, acceptance is **two facts in
the receipt**, not one:

1. `"status": "EXECUTED"`
2. a `fill_verification` object carrying `"ok": true`

The second is not redundant. When the directive carries an `execution_request`,
the bridge queries connector positions before the run and again after it and
compares the delta against `qty`; a miss rewrites the status to `FAILED` with
`reason: order_not_filled` (nothing moved) or `reason: partial_fill` (something
moved, short of the mandate). Two details decide whether that comparison is
right, and both have bitten in production:

- **Symbol dialects.** The venue does not echo the directive's spelling:
  Alpaca reports the pair `BTC/USD` as `BTCUSD` and drops the `.US` venue
  suffix from equities. Matching is done on normalized symbols with a
  suffix-only fallback, so `BTC/USD` ≡ `BTCUSD` and `AAPL.US` ≡ `AAPL`, while
  `BTC/USD` ≠ `BTC/USDT`.
- **A mandated size is not an exact size.** Alpaca paper delivered `0.0009975`
  BTC for a mandated `0.001` — on **both** landed buys observed so far, i.e.
  exactly -0.25 % each time. The receipt does not say whether that is an
  in-kind fee, lot rounding, or a partial fill. A shortfall within
  `BRIDGE_FILL_TOLERANCE_PCT` (default `0.005` = 0.5 % of the mandated size,
  floor `1e-6`) is therefore accepted; below that bar but above zero is
  `partial_fill`. On this venue `0` is unusable for crypto: with the observed
  -0.25 % haircut, exact-match discipline reads every crypto buy that lands as
  `partial_fill`. Keep `0` for equities, where fills have been exact.

But when the directive
carries **no** `execution_request`, the whole check is skipped
(`if execution is not None and outcome == "EXECUTED" and not cfg.skip_fill_check`),
no `fill_verification` is written, and `EXECUTED` then means only "the agent
process exited 0". The contract mandates an `execution_request` for any exposure
change, so the field's presence is the evidence that the mandate was honoured —
and its absence is a receipt that proves nothing about the broker.
`BRIDGE_SKIP_FILL_CHECK=1` removes the field too: a receipt produced in that mode
can never prove an execution.

### What a failed receipt can say about itself

Both rules above make the *comparison* right. Neither one explains an agent
that exits 0 and places nothing, and that is the third field to read:
**`run_evidence`**. When a fill check fails, the bridge copies from the run
directory the agent reported (`agent_result.run_dir`):

| Field | Source | Why it matters |
|---|---|---|
| `terminal_state` | `state.json` | the run's terminal state. In the observed case, 25 bytes: `{"status": "success"}`. |
| `identity` | `artifacts/grounding_evidence.json` | the identity the ledger actually locked — what a mismatch is measured against. |
| `tool_failures` | same | every tool call with its `error_code`. A gate rejection the CLI never prints. |
| `rejected_tool_calls` | same, when `tool_failures` is absent | shape-agnostic fallback: any object carrying a non-null `error_code`. |
| `files` | the run directory | what the run left behind, so you know whether an autopsie is even possible. |

Without it, `stdout_tail` (the CLI's one-line status: `status`, `run_id`,
`run_dir`, `reason`) and `prompt_tail` (the END of the prompt, not the answer)
are all a failed receipt says — which is why three consecutive
`FAILED / order_not_filled` receipts had to be explained by reading artifacts by
hand. The copy stays small (strings clipped at 300 characters, lists at 12
items, failures at 8) so Hermès can still read the receipt. It is best-effort: a
missing directory, unreadable or malformed JSON, or a shape change upstream
leaves the receipt exactly as it was.

The fastest honest proof, in two parts — the sample exercises the rail Alpaca
crypto, which trades 24/7 and so carries no market-hours dependency (equities
legitimately fail closed outside 13:30–20:00 UTC on weekdays):

```bash
# The sample's own id (DIR-SYNTH-CRYPTO-20260907-120000-001) is spent the first
# time it is dropped: a re-drop is skipped as already processed. Mint a fresh id.
python3 -c "
import json,pathlib
d=json.loads(pathlib.Path('bridge/sample-directive-crypto-alpaca.json').read_text())
d['directive_id']='DIR-SYNTH-CRYPTO-<YYYYMMDD-HHMMSS>-001'
pathlib.Path('/tmp/rail-check.json').write_text(json.dumps(d,indent=2))
"
docker cp /tmp/rail-check.json bridge:/var/lib/bridge/directives/
docker exec bridge sh -c 'cat "$(ls -t /var/lib/bridge/executions/*.json | head -1)"'
#   status: EXECUTED  +  fill_verification.ok: true

# the out-of-band check: the broker, queried by you rather than by the bridge
docker exec vibe-trading vibe-trading connector positions
```

Observed end-to-end on 2026-09-18 (drop at 17:14Z, run
`20260918_171459_41_97b4fc`):

```json
{
  "directive_id": "DIR-SYNTH-CRYPTO-20260918-180000-001",
  "status": "EXECUTED",
  "exit_code": 0,
  "agent_result": { "status": "success", "run_id": "20260918_171459_41_97b4fc" },
  "fill_verification": {
    "ok": true,
    "detail": "BTC/USD: 0.0009975 -> 0.001995 (delta 0.0009975) [broker row 'BTCUSD']; expected BTC/USD qty to rise by >= 0.001 (was 0.0009975)"
  }
}
```

That proves the **execution rail**. Proving that **Hermès** can execute is the
same two fields on a directive Hermès wrote under its own id — which is the
remaining open item, and the only version that also closes rule 8.

### The first real run, observed (2026-09-17T21:46Z)

This is what acceptance looked like — not a placeholder, the actual receipt:

```json
{
  "directive_id": "DIR-20260917-214500-001",
  "version": 2,
  "mode": "PAPER",
  "action_directive": "NO_ACTION",
  "status": "NO_EXECUTION",
  "processed_at": "2026-09-17T21:46:30Z",
  "executed_at": "2026-09-17T21:46:30Z",
  "connector": "alpaca-paper-trade",
  "note": "action_directive does not request exposure change; recorded without execution"
}
```

Read it correctly before calling it thin:

- `NO_ACTION` → nothing to execute, so there is no `agent_result` and no
  `run_id`. That field only exists for directives that reached the agent.
- 357 bytes is the *size of a decision not to trade*, not a truncated receipt.
- The **receipt** stays where it is forever: `executions/` is append-only and the
  receipt is the idempotence key. Only the directive *file* is droppable, via
  `--archive`.

Two legitimate-looking results that are not failures:

- A directive carrying `NO_EXECUTION` is a complete success. `action_directive`
  `NO_ACTION` / `PAUSE_TRADING` / `DE_RISK` is recorded without an order
  (DE_RISK position reduction is not implemented yet) — no market hours needed.
- A mandated `execution_request` dropped outside US market hours (13:30–20:00
  UTC, weekdays) legitimately fails closed on `order_not_filled`. Re-drop under a
  **fresh `directive_id`** during hours; a final id never re-runs.

## Multi-asset paper: crypto, Binance testnet

Since the fractional ban was lifted (prompt rule 5), `execution_request` can
carry any positive size the broker accepts — `0.001` BTC, `0.5` share, `2500`
forex units. The fill guard compares float quantities with a tolerance, so a
fractional fill verifies exactly like a whole-share one.

- **Crypto on Alpaca paper (zero new setup)**: Alpaca's paper account trades
  crypto 24/7 (`BTC/USD`, `ETH/USD`, ...) with the same key pair — confirmed
  here rather than assumed: a `BTC/USD` buy filled and verified at 05:27Z,
  outside the 13:30-20:00Z equity window. Drop
  `sample-directive-crypto-alpaca.json` and keep `BRIDGE_CONNECTOR` at its
  default — the bridge prompt already canonicalizes `BTC/USD` as the run
  identity (no `.US` suffix is added to crypto shapes, and the symbol-dialect
  rule collapses to a single dialect for them). The **positions row** comes
  back in the other dialect (`BTCUSD`, no slash), which the fill guard
  normalizes — do not compare the receipt's `detail` string with the
  directive symbol by eye and conclude the fill is missing.
- **Binance spot testnet (`testnet.binance.vision`)**: upstream Vibe-Trading
  ships the `binance-paper-trade` profile (ccxt → testnet host) — the
  testnet is a developer sandbox: sign in with a **GitHub account** on
  testnet.binance.vision, mint API keys there (spot trading enabled), and
  they can only ever reach the sandbox, never real funds. Binance is
  geo-blocked in France for its *live* service; the testnet is not an
  exchange service and is unaffected. Wiring:
  1. Create keys at https://testnet.binance.vision (GitHub login, enable
     spot + enable reading). Fund the sandbox with the testnet faucet
     (free BTC/USDT/ETH/USDT).
  2. Configure the connector in the shared runtime (vibe_data volume) —
     either `docker exec vibe-trading vibe-trading connector ...`
     onboarding or a `~/.vibe-trading/binance.json` mirroring
     `alpaca.json` with `{"api_key": ..., "api_secret": ...,
     "profile": "paper"}` (paper → testnet host is structural).
  3. Check the link before any directive:
     `docker exec vibe-trading vibe-trading connector check
     binance-paper-trade` — if it reports `ccxt is not installed`, rebuild
     the image (the repo Dockerfile installs ccxt since 2026-09-07).
  4. Point the bridge at it: `BRIDGE_CONNECTOR=binance-paper-trade` in
     `deploy/oci/.env`, then `docker compose up -d bridge` (env changes
     only apply at container-create time).
  5. Drop `sample-directive-crypto-binance.json` (`BTC/USDT` 0.001) and
     read the receipt as usual. Testnet fills simulate the real Binance
     order book (spread, slippage, partial fills), which makes it a far
     stricter forward test than Alpaca paper fills for news/momentum
     edges.
- **Switching the runtime-selected profile** (any non-default connector):
  the bridge's fill check runs `vibe-trading connector positions` with no
  profile flag, and the CLI resolves that call through the selected
  profile stored in `~/.vibe-trading/trading-connections.json` (upstream
  `src/trading/profiles.py`). When you point the bridge at a new
  connector, also switch the selected profile — set it via the CLI
  onboarding (`vibe-trading connector select <profile>`) or write the
  file directly:
  `docker exec vibe-trading sh -c 'echo "{\"selected_profile\":
  \"<profile>\"}" > /home/vibe/.vibe-trading/trading-connections.json'`
  — otherwise the agent trades the new connector but the fill guard keeps
  reading the previous connector's positions.
- **Forex (OANDA fxTrade Practice)**: not yet a built-in connector upstream.
  A complete, ready-to-submit connector (reads + orders, zero new runtime
  dependency — OANDA v20 REST over stdlib) lives in
  `deploy/oci/upstream/oanda-vibe-trading-pr/` with the PR body and the
  exact submission commands. Until it merges upstream you can install the
  read-only practice plugin from the same package today
  (`vibe-trading connector validate . && vibe-trading connector install .`)
  for account/position reads and research commissions; order execution
  needs the full connector (apply the patch to your checkout and build the
  image from your fork: `VIBE_TRADING_VERSION=feat/oanda-connector`).

## Kill switch, dry run, env

| Var | Default | Meaning |
|---|---|---|
| `BRIDGE_HOME` | `/var/lib/bridge` | Exchange root |
| `BRIDGE_POLL_S` | `15` | Watch loop tick |
| `BRIDGE_MAX_ITER` | `30` | Agent iteration cap |
| `BRIDGE_TIMEOUT_S` | `900` | Agent subprocess timeout |
| `BRIDGE_CONNECTOR` | `alpaca-paper-trade` | Paper connector profile (`binance-paper-trade` for the Binance spot testnet — also switch the runtime-selected profile, see above; `oanda-practice-trade` once the OANDA PR lands) |
| `BRIDGE_MAX_QTY` | `3` | Reserved per-order quantity cap (not yet embedded in the prompt — discretionary orders are capped by gross notional ≈ $5k of the $100k paper account; mandated `execution_request` orders are operator-sized) |
| `BRIDGE_DRY_RUN` | `0` | `1` logs the prompt, never invokes the agent |
| `BRIDGE_ALLOW_RESEARCH` | `0` | `1` lets `mode: RESEARCH` commissions run as read-only agent tasks |
| `BRIDGE_SKIP_FILL_CHECK` | `0` | `1` trusts the agent's exit code for `execution_request` directives (disables the positions-based fill verification — not recommended) |
| `BRIDGE_FILL_TOLERANCE_PCT` | `0.005` | Accepted shortfall between the mandated `qty` and the fill, as a fraction of `qty` (in-kind venue fees, lot rounding; floor `1e-6`). `0` = exact match. Beyond it, a receipt that moved the position is `FAILED` / `partial_fill` |
| `BRIDGE_VIBE_TRADING_BIN` | `vibe-trading` | CLI binary path |
| `BRIDGE_LOG_LEVEL` | `INFO` | Log level. `DEBUG` also shows the per-tick "already processed; skipping" lines |

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
- **Run artifact shows `tool_failures` with `error_code: identity_required`
  (agent still exits 0)**: the upstream Vibe-Trading identity gate
  (`vibe-trading-ai@v0.1.14`, `agent/src/agent/grounding.py`) blocks any
  symbol-bearing order/market-data tool call until a venue-qualified
  identity is *locked*. A directive naming a bare ticker (`AAPL`) seeds no
  identity, so the model's first `trading_place_order` attempt is blocked
  (`identity_required`) unless `search_symbol` completed in an **earlier**
  turn — a resolver and a consumer in the same response never works, and
  the model sometimes finalizes instead of retrying. The bridge fix
  (`build_prompt`) canonicalizes the directive instrument to `SYMBOL.US`
  and states it as `RUN INSTRUMENT IDENTITY` in the prompt: the ledger
  seeds that exact symbol locked at run start, so the mandated order is
  authorized before the first batch (verified against the upstream ledger
  locally). Two symbol dialects are now spelled out in the prompt: the
  canonical identity (`AAPL.US`) authorizes, while connector tool calls
  pass the broker-native ticker (`AAPL`) — see the `42210000` entry below.
  The prompt also forbids batching `search_symbol` with other calls and
  forbids reporting success for an un-landed order. Diagnose a fresh run
  with:
  `docker exec bridge python3 -c "import json;d=json.load(open('/home/vibe/.vibe-trading/runs/<run_id>/artifacts/grounding_evidence.json'));print(json.dumps({'identity':d.get('identity'),'tool_failures':d.get('tool_failures')},indent=1))"`
  — expect identity `locked` from the start (`source: user_message`) and an
  empty `tool_failures`.
- **Run artifact `tool_failures` shows `{"code":42210000,"message":"asset
  \"AAPL.US\" not found"}` from `trading_place_order`**: the identity gate
  passed (identity `locked`) but the *symbol dialect* was wrong. Upstream
  (vibe-trading-ai v0.1.14) authorizes venue-qualified canonical symbols
  (`AAPL.US`) yet forwards order/quote arguments verbatim to the broker
  SDK, and Alpaca only knows bare `AAPL` — `trading_place_order`'s own
  schema documents the broker-native shape (`AAPL, BTC-USDT, 700.HK`). The
  bridge prompt now names both: connector tools receive the broker-native
  symbol (the identity gate accepts it via unique-base matching), never the
  venue-suffixed identity. A fresh drop during US market hours should show
  a clean fill; outside hours it will still fail closed on
  `order_not_filled`, which is correct.
- **Receipt `FAILED` with `order_not_filled` / `fill_verification_unavailable`
  after the agent returned exit 0**: the fill guard doing its job. The
  bridge now compares connector positions before and after a mandated
  `execution_request` run and fails the receipt when the order did not
  land. Common causes: the US market is closed (a market order cannot fill
  outside 13:30–20:00 UTC on weekdays), or an agent-side execution failure
  that still exits 0 (an identity-gate block — see the previous entry —
  or a broker rejection the model failed to report). The agent run id is
  in `agent_result.run_id` and its artifacts at
  `/home/vibe/.vibe-trading/runs/<run_id>/`. Re-drop under a **fresh
  `directive_id`** after fixing the cause. Re-runs outside US market hours
  will legitimately fail closed — that is the intended behavior. Opt out
  per-operations with `BRIDGE_SKIP_FILL_CHECK=1`.
- **The same crypto directive failed once and filled 20 minutes later**
  (observed 2026-09-18): two drops of the identical sample under fresh ids
  gave a genuine non-fill at 16:55Z (the positions read `0.0009975` before and
  after it, and again before the next run) and a verified fill at 17:15Z. A
  `FAILED` / `order_not_filled` on crypto is therefore not automatically the
  symbol bug or the market hours. In that case the run's artifact names the
  cause: `tool_failures` carries `error_code: identity_mismatch` on
  `trading_place_order` — "Consumer symbol/venue differs from the locked
  resolver identity; silent suffix or exchange rewrites are forbidden" — so the
  order was refused by the identity gate in-process and never reached Alpaca.
  That grep does not show *which* two spellings clashed; the window below puts
  the symbol the model passed next to the locked identity. The receipt of that
  run predates the fix and does **not** carry the cause: its `stdout_tail` holds
  only the CLI's final status line (`status`, `run_id`, `run_dir`, `reason`),
  never the agent's account of the order it tried. Receipts written from this
  revision include it as `run_evidence` (see "What proves a directive was really
  executed"), so this autopsie is only needed for an older run:

  ```bash
  # take the run id out of the receipt instead of typing it by hand
  RID=$(docker exec bridge sh -c \
    "cat /var/lib/bridge/executions/DIR-SYNTH-CRYPTO-20260918-070000-001.json" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['agent_result']['run_id'])")
  docker exec vibe-trading ls -la /home/vibe/.vibe-trading/runs/$RID/
  docker exec vibe-trading sh -c \
    "sed -n '100,160p' /home/vibe/.vibe-trading/runs/$RID/artifacts/grounding_evidence.json"
  ```

  In the case above the receipt proves only that the run is worth reading: it
  exited `0`, reported `success`, wrote nothing to stderr, and no order landed.
- **Run artifact shows `error_code: identity_mismatch` on
  `trading_place_order`** (observed 2026-09-18T16:55Z): the gate locked one
  spelling and the order tool was handed another — the order never reached the
  broker, so the positions could not move. The prompt used to contradict itself
  here: rule 3 forbade `search_symbol` for the mandated instrument and, three
  lines later, prescribed it as *the* recovery from an identity error. For a
  broker-native mandate (crypto, futures, FX) resolving is the cause, not the
  cure — Alpaca writes `BTC/USD` as `BTCUSD` (its own position rows say so), so
  a resolver locks `BTCUSD` and every retry of the mandate's spelling is then
  refused as a mismatch. Rule 3 now says: do not end the run, do not resolve,
  retry the exact mandated symbol alone. **Deduced** from the artifact plus the
  broker's row spelling — the run that confirms it is the next fresh drop, whose
  receipt will carry `identity` for exactly this reason.
- **Receipt `FAILED` with `order_not_filled` while the position is visibly
  there** (observed 2026-09-18T05:28Z: mandated `0.001` `BTC/USD`, broker row
  `BTCUSD` holding `0.0009975`, receipt said `0 -> 0`): the venue's row
  spelling did not match the directive symbol, and the mandated-vs-landed gap
  (0.25 %) exceeded a hard 1e-6 tolerance. Both are fixed: matching is
  dialect-aware and the allowance is relative. The receipt names the row it
  matched (`[broker row '…']`); when that note is absent, no row matched at
  all. A receipt produced before the fix is final — re-run under a **fresh
  `directive_id`**.
- **`docker compose up` → `Container "/vibe-trading" is already in use`**:
  a leftover standalone `vibe-trading` container from the old
  `~/trading-stack` quickstart still holds the name. Retire that project
  once (`cd ~/trading-stack && docker compose down` — the `vibe_data`
  volume and the paper profile are kept), then bring the consolidated
  stack up from `deploy/oci`.

## Companion documents

- `hermes-contract.md` — the paste-ready INTERFACE CONTRACT for Hermès:
  adds the `read_receipts` and `commission_research` skills that turn the
  bridge receipts into the learning loop, plus the directive vocabulary
  (including `RESEARCH` mode) in one prompt. The filename carries **no
  version** on purpose: the version lives in the file's own changelog and
  in git history, so a bump never forks the document into a second copy.
- `push-contract.sh` — pushes that one file to the one path Hermès reads
  (`/opt/data/hermes/INTERFACE_CONTRACT.md` inside the `hermes` container,
  both overridable), then verifies the rules 8/9/10 markers landed. Run it
  with `--check` to diff the repo copy against the persisted one without
  writing anything — that is the divergence guard.
- `sample-directive.json` / `sample-directive-synthetic.json` /
  `sample-directive-research.json` — the three directive shapes, plus
  `sample-directive-crypto-alpaca.json` (BTC/USD 0.001 on
  `alpaca-paper-trade`),  `sample-directive-crypto-binance.json`
  (BTC/USDT 0.001 on `binance-paper-trade`).
- `deploy/oci/upstream/oanda-vibe-trading-pr/` — the ready-to-submit
  OANDA connector PR for upstream Vibe-Trading (practice/live profiles,
  PR body, registry changes, local read-only plugin).

## Limits of this version (declare them)

- Execution is delegated to the agent's judgment within the prompt's
  guardrails; the bridge does not re-price orders. For directives that
  carry an `execution_request` it DOES verify the fill against connector
  positions and fails the receipt when the mandated order did not land;
  discretionary directives (no `execution_request`) are not fill-checked.
- Research commissions are read-only by *prompt contract*, not by sandbox:
  the agent is trusted to stay out of order tools. Keep
  `BRIDGE_ALLOW_RESEARCH=0` unless you accept that trust boundary.
- No DE_RISK closing logic yet (recorded, not executed).
- The agent run is serialized (one directive at a time, per receipt lock).
- **Paper fills are idealized**: Alpaca paper fills at a reference mid with no
  spread/slippage — precisely the wrong model for news trading, where
  execution IS the edge. Vibe-Trading's own backtest fills signals on the
  **next bar's open** (upstream #1299: no same-bar fill, no lookahead) — a
  backtest is an estimate of signal quality under that convention, not of
  live fills. For validation: backtest for signal quality, forward-test on
  the Binance testnet (real order book simulation) for execution realism.
- The base image must exist locally before `--build` runs:
  `vibe-trading:arm64` is produced by `docker compose up -d --build vibe-trading`.