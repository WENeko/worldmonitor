#!/usr/bin/env python3
"""directive-bridge — Hermès ⇄ Vibe-Trading execution bridge (fork-owned).

Watches a shared exchange directory for Macro Director directives (JSON
files written by Hermès), and for each actionable one hands the directive
to the Vibe-Trading agent for execution, then writes an execution receipt
back to the same volume that Hermès can read. PAPER-only by construction.

Why this exists (see deploy/oci/bridge/README.md for the full contract):

- Hermès is the Macro Director: it emits directives, it never touches an
  order tool. The bridge is the operator-owned automation between a
  directive and its execution.
- The upstream Vibe-Trading MCP server deliberately exposes NO order or
  cancel tools (agent/mcp_server.py docstring). The only execution path
  is the internal agent runtime, which holds `trading_place_order`.
- The bridge therefore reuses the same `vibe-trading:arm64` image and
  shares the same runtime volume (connector selection + credentials), and
  invokes the same headless command the operator would run by hand:
  `vibe-trading -p "<instruction>" --json --max-iter N`.

Fail-closed rules:

- Only directives with `mode` PAPER or PAPER_SYNTHETIC_TEST are eligible
  for execution. Anything else is recorded and skipped (REJECTED).
- `NO_ACTION` / `PAUSE_TRADING` / `DE_RISK` are never executed by this
  version: they are recorded as NO_EXECUTION so the loop is auditable
  (later versions may turn DE_RISK into a position-reduction order).
- `mode: RESEARCH` directives are never executed against the broker:
  they are handed to the agent as a read-only research task (market data,
  indicators, correlations) with orders forbidden. Research is gated by
  `BRIDGE_ALLOW_RESEARCH` (default off); while gated, a RESEARCH
  directive is recorded as `GATED` and re-processable once enabled.
- Execution is idempotent: one receipt per `directive_id`, in
  `<home>/executions/<directive_id>.json`. Re-delivering the same
  directive does nothing (a `GATED` receipt is not final and can be
  re-processed).
- `BRIDGE_DRY_RUN=1` logs what would run instead of invoking the agent.

Modes:
    python bridge.py --loop      watch forever (container default)
    python bridge.py --once      process everything pending, then exit
    python bridge.py --check     print configuration and directory layout
    python bridge.py --check --probe  same, plus a live LLM gateway ping
                                (prints HTTP status; exit 1 unless 200)
    python bridge.py --file X    process a single directive file
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LOG = logging.getLogger("directive-bridge")

DIRECTIVE_VERSION = 2

# Directional directives that actually request exposure change. Everything
# else (NO_ACTION / PAUSE_TRADING / DE_RISK) is recorded, never executed.
EXECUTABLE_ACTIONS = frozenset(
    {"INCREASE_LONG_SENSITIVITY", "INCREASE_SHORT_SENSITIVITY"}
)
KNOWN_ACTIONS = EXECUTABLE_ACTIONS | {
    "NO_ACTION",
    "PAUSE_TRADING",
    "DE_RISK",
}
KNOWN_BIASES = {"BULLISH", "BEARISH", "NEUTRAL"}
ALLOWED_MODES = {"PAPER", "PAPER_SYNTHETIC_TEST", "RESEARCH"}

REQUIRED_FIELDS = (
    "directive_id",
    "timestamp",
    "target_asset",
    "macro_bias",
    "confidence_score",
    "timeframe_hours",
    "action_directive",
    "reasoning",
)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def env_setting(name: str, default: str) -> str:
    return os.environ.get(name, default)


class BridgeConfig:
    def __init__(self) -> None:
        self.home = Path(env_setting("BRIDGE_HOME", "/var/lib/bridge"))
        self.directives = self.home / "directives"
        self.executions = self.home / "executions"
        self.audit = self.home / "audit"
        self.poll_s = int(env_setting("BRIDGE_POLL_S", "15"))
        self.max_iter = int(env_setting("BRIDGE_MAX_ITER", "30"))
        self.timeout_s = int(env_setting("BRIDGE_TIMEOUT_S", "900"))
        self.connector = env_setting("BRIDGE_CONNECTOR", "alpaca-paper-trade")
        self.dry_run = env_setting("BRIDGE_DRY_RUN", "0") not in ("", "0", "false")
        self.research_allowed = env_setting("BRIDGE_ALLOW_RESEARCH", "0") not in (
            "",
            "0",
            "false",
        )
        self.max_qty = int(env_setting("BRIDGE_MAX_QTY", "3"))
        self.vibe_bin = shutil.which(
            env_setting("BRIDGE_VIBE_TRADING_BIN", "vibe-trading")
        )

    def ensure_dirs(self) -> None:
        for d in (self.directives, self.executions, self.audit):
            d.mkdir(parents=True, exist_ok=True)

    def describe(self) -> str:
        return (
            f"home={self.home}\n"
            f"  directives={self.directives}\n"
            f"  executions={self.executions}\n"
            f"  audit={self.audit}\n"
            f"poll_s={self.poll_s} max_iter={self.max_iter} "
            f"timeout_s={self.timeout_s}\n"
            f"connector={self.connector} dry_run={self.dry_run}\n"
            f"research_allowed={self.research_allowed}\n"
            f"vibe_trading_bin={self.vibe_bin or 'NOT FOUND'}\n"
            f"llm_env: api_key={'set' if os.environ.get('OPENAI_API_KEY') else 'MISSING'} "
            f"base_url={os.environ.get('OPENAI_BASE_URL') or 'UNSET (would default to api.openai.com)'}"
        )


# ---------------------------------------------------------------------------
# LLM gateway probe
# ---------------------------------------------------------------------------


def probe_llm_gateway() -> tuple[int, str]:
    """Live ping of the LiteLLM gateway through the same env the agent uses.

    Uses OPENAI_API_KEY (the LiteLLM master key), OPENAI_BASE_URL and
    LANGCHAIN_MODEL_NAME — all injected by compose. Returns (http_status,
    detail); status is 0 when the gateway was unreachable. A 401/400 body
    here means the gateway is healthy and the *provider* behind it rejected
    the credential (missing or invalid provider key in .env) — not a bridge
    problem.
    """
    import urllib.error
    import urllib.request

    api_key = os.environ.get("OPENAI_API_KEY", "")
    base_url = os.environ.get("OPENAI_BASE_URL", "")
    model = os.environ.get("LANGCHAIN_MODEL_NAME", "")
    if not api_key:
        return 0, "OPENAI_API_KEY is empty (master key not propagated to bridge)"
    if "127.0.0.1" not in base_url and "localhost" not in base_url:
        return 0, f"OPENAI_BASE_URL '{base_url}' does not point at the local gateway"
    url = base_url.rstrip("/") + "/chat/completions"
    payload = json.dumps(
        {"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 8}
    ).encode()
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, ""
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        return error.code, body[:280].replace("\n", " ")
    except Exception as error:  # connection refused, timeout, DNS…
        return 0, f"{type(error).__name__}: {error}"


# ---------------------------------------------------------------------------
# Directive validation & classification
# ---------------------------------------------------------------------------


def validate_directive(data: dict) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "directive is not a JSON object"
    for field in REQUIRED_FIELDS:
        value = data.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            return False, f"missing or empty required field '{field}'"
    if data.get("version") is not None and data["version"] > DIRECTIVE_VERSION:
        return False, f"directive version {data['version']} newer than supported"
    mode = data.get("mode", "PAPER")
    if mode not in ALLOWED_MODES:
        return False, f"mode '{mode}' not in {sorted(ALLOWED_MODES)}"
    if data["macro_bias"] not in KNOWN_BIASES:
        return False, f"unknown macro_bias '{data['macro_bias']}'"
    if data["action_directive"] not in KNOWN_ACTIONS:
        return False, f"unknown action_directive '{data['action_directive']}'"
    try:
        confidence = float(data["confidence_score"])
        if not 0.0 <= confidence <= 1.0:
            return False, "confidence_score out of [0, 1]"
    except (TypeError, ValueError):
        return False, "confidence_score is not a number"
    try:
        if float(data["timeframe_hours"]) < 0:
            return False, "timeframe_hours is negative"
    except (TypeError, ValueError):
        return False, "timeframe_hours is not a number"
    execution = data.get("execution_request")
    if execution is not None:
        if not isinstance(execution, dict):
            return False, "execution_request is not an object"
        for field in ("symbol", "side", "qty"):
            if not execution.get(field):
                return False, f"execution_request missing '{field}'"
        try:
            qty = float(execution["qty"])
        except (TypeError, ValueError):
            return False, "execution_request.qty is not a number"
        if qty <= 0:
            return False, "execution_request.qty is not positive"
        if execution.get("side") not in ("BUY", "SELL"):
            return False, "execution_request.side must be BUY or SELL"
    if mode == "RESEARCH":
        if execution is not None:
            return False, "execution_request is forbidden in RESEARCH mode"
        if not str(data.get("research_question") or "").strip():
            return False, "RESEARCH mode requires non-empty 'research_question'"
    return True, "ok"


def classify_directive(data: dict) -> str:
    """Return one of EXECUTE / NO_EXECUTION / RESEARCH / REJECTED."""
    ok, error = validate_directive(data)
    if not ok:
        return "REJECTED"
    if data.get("mode") == "RESEARCH":
        return "RESEARCH"
    if data["action_directive"] in EXECUTABLE_ACTIONS:
        return "EXECUTE"
    return "NO_EXECUTION"


def _json_block(text: str) -> dict | None:
    """Best-effort extraction of a JSON object from an agent's stdout."""
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    for candidate in text.splitlines():
        candidate = candidate.strip()
        if candidate.startswith("{") and candidate.endswith("}"):
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                continue
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return None


def build_prompt(cfg: BridgeConfig, data: dict) -> str:
    directive = json.dumps(data, indent=2, ensure_ascii=False)
    execution = data.get("execution_request")
    order_rule = (
        (
            'If "execution_request" is present, execute EXACTLY that order '
            f"({execution['symbol']} {execution['side']} qty "
            f"{execution['qty']} {execution.get('order_type', 'market')}) and "
            "nothing else."
        )
        if execution
        else (
            "Otherwise translate the directive into at most one order "
            f"(market or limit), sized so the position is small "
            f"(gross exposure well under $5k of the $100k paper account)."
        )
    )
    return f"""You are executing a Macro Director directive delivered by the
operator's automation bridge (Hermès ⇄ Vibe-Trading). Execute it, then report.

DIRECTIVE:
{directive}

EXECUTION RULES (operator contract, non-negotiable):
1. This is a PAPER environment. Use connector "{cfg.connector}".
   Never select, configure, or reference any live/trading profile.
2. {order_rule}
3. Respect Vibe-Trading's own mandate and fail-closed pre-trade checks
   (universe, size caps, exposure, daily cap). If a check blocks the
   order, report the block verbatim — do not work around it.
4. No leverage, no margin, no options, no fractional size.
5. After any order attempt, read connector account and positions and
   include the resulting state in your final summary.
6. Report as concise JSON: run id, what you did, order result, and the
   resulting account/position state."""


def build_research_prompt(cfg: BridgeConfig, data: dict) -> str:
    directive = json.dumps(data, indent=2, ensure_ascii=False)
    question = data.get("research_question", "")
    return f"""You are the research arm of a Macro Director loop, running a
read-only research commission delivered by the operator's automation bridge
(Hermès ⇄ Vibe-Trading).

RESEARCH COMMISSION:
{directive}

QUESTION TO ANSWER:
{question}

RESEARCH RULES (operator contract, non-negotiable):
1. This is a RESEARCH task. You are strictly read-only: you may query
   quotes, bars, account state, strategies and evidence using the
   connector "{cfg.connector}" and Vibe-Trading's analytical tools.
2. You MUST NOT place, modify or cancel any order, and you must not
   invoke any order/execution tool. If the question seems to require a
   trade, answer with the analysis and note that no order was placed.
3. Stay on paper market data; never reference or select a live profile.
4. Keep compute bounded: stop at a concise, evidence-backed answer.
   Cite which data/tools you actually used.
5. Report as concise JSON: summary finding, key numbers/evidence,
   tools_used, and an explicit "orders_placed": 0."""


def run_agent(cfg: BridgeConfig, prompt: str) -> dict:
    """Invoke the headless Vibe-Trading agent; return a receipt fragment."""
    if cfg.vibe_bin is None:
        return {
            "status": "FAILED",
            "error": "vibe-trading binary not found on PATH",
        }
    # Fail-closed LLM routing guard: the agent subprocess inherits this
    # process env. Without OPENAI_API_KEY the run dies with an opaque OpenAI
    # traceback (seen in the field); with a LiteLLM master key set but
    # OPENAI_BASE_URL unset, the key would be sent to api.openai.com instead
    # of the local gateway. Refuse loudly and point at the fix.
    if not os.environ.get("OPENAI_API_KEY"):
        return {
            "status": "FAILED",
            "error": (
                "OPENAI_API_KEY is empty — set LITELLM_MASTER_KEY in "
                "deploy/oci/.env, then recreate the stack: docker compose up "
                "-d --build litellm vibe-trading bridge"
            ),
        }
    base_url = os.environ.get("OPENAI_BASE_URL") or ""
    if "127.0.0.1" not in base_url and "localhost" not in base_url:
        return {
            "status": "FAILED",
            "error": (
                f"OPENAI_BASE_URL '{base_url or '(unset)'}' does not point at "
                "the local LiteLLM gateway (expected "
                "http://127.0.0.1:4000/v1); refusing to send the key elsewhere"
            ),
        }
    cmd = [cfg.vibe_bin, "-p", prompt, "--json", "--max-iter", str(cfg.max_iter)]
    LOG.info("running %s (%d chars prompt, max_iter=%d)",
             cfg.vibe_bin, len(prompt), cfg.max_iter)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=cfg.timeout_s,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", "error": f"agent exceeded {cfg.timeout_s}s"}
    except OSError as exc:
        return {"status": "FAILED", "error": f"could not start agent: {exc}"}
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    outcome = _json_block(stdout)
    return {
        "status": "EXECUTED" if proc.returncode == 0 else "FAILED",
        "exit_code": proc.returncode,
        "agent_result": outcome,
        "stdout_tail": stdout[-2000:] or None,
        "stderr_tail": stderr[-1000:] or None,
    }


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------


def build_receipt(cfg: BridgeConfig, data: dict, outcome: str, extra: dict) -> dict:
    receipt = {
        "directive_id": data.get("directive_id"),
        "version": DIRECTIVE_VERSION,
        "mode": data.get("mode", "PAPER"),
        "action_directive": data.get("action_directive"),
        "status": outcome,
        "processed_at": utcnow(),
        "executed_at": utcnow(),
        "connector": cfg.connector,
    }
    receipt.update(extra)
    return receipt


def write_receipt(cfg: BridgeConfig, receipt: dict) -> None:
    filename = f"{receipt['directive_id']}.json"
    target = cfg.executions / filename
    tmp = cfg.executions / f".{filename}.tmp"
    tmp.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(target)
    with (cfg.audit / "audits.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(receipt, ensure_ascii=False, default=str) + "\n")


def process_file(cfg: BridgeConfig, path: Path) -> None:
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        LOG.error("invalid JSON in %s: %s", path.name, exc)
        write_receipt(cfg, {
            "directive_id": path.stem,
            "version": DIRECTIVE_VERSION,
            "status": "REJECTED",
            "processed_at": utcnow(),
            "connector": cfg.connector,
            "error": f"invalid JSON: {exc}",
        })
        return
    except OSError as exc:
        LOG.error("unreadable %s: %s", path.name, exc)
        return

    directive_id = data.get("directive_id")
    if not directive_id:
        LOG.error("%s has no directive_id; skipped", path.name)
        return

    receipt_path = cfg.executions / f"{directive_id}.json"
    if receipt_path.exists():
        try:
            previous = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            previous = None
        parked_and_gate_open = (
            previous is not None
            and previous.get("status") == "GATED"
            and cfg.research_allowed
        )
        if previous is not None and not parked_and_gate_open:
            LOG.info("directive %s already processed; skipping", directive_id)
            return
        if parked_and_gate_open:
            LOG.info(
                "directive %s has a GATED receipt and research is now "
                "enabled; re-processing",
                directive_id,
            )

    classification = classify_directive(data)
    LOG.info("directive %s classified as %s", directive_id, classification)

    if classification == "REJECTED":
        ok, error = validate_directive(data)
        receipt = build_receipt(cfg, data, "REJECTED", {
            "error": error or "validation failed",
            "directive_received": data,
        })
        write_receipt(cfg, receipt)
        LOG.warning("rejected %s: %s", directive_id, error)
        return

    if classification == "NO_EXECUTION":
        receipt = build_receipt(cfg, data, "NO_EXECUTION", {
            "note": "action_directive does not request exposure change; "
                    "recorded without execution",
        })
        write_receipt(cfg, receipt)
        LOG.info("recorded %s as NO_EXECUTION", directive_id)
        return

    if classification == "RESEARCH":
        if not cfg.research_allowed:
            receipt = build_receipt(cfg, data, "GATED", {
                "note": "BRIDGE_ALLOW_RESEARCH=0 — research commission parked "
                        "without execution; re-processed automatically once the "
                        "gate is enabled (this receipt is not final).",
            })
            write_receipt(cfg, receipt)
            LOG.info("research %s parked as GATED (gate closed)", directive_id)
            return

        prompt = build_research_prompt(cfg, data)
        if cfg.dry_run:
            receipt = build_receipt(cfg, data, "DRY_RUN", {
                "note": "BRIDGE_DRY_RUN=1 — agent not invoked",
                "prompt": prompt,
            })
            write_receipt(cfg, receipt)
            LOG.info("dry-run: would research %s (%d chars)", directive_id, len(prompt))
            return

        fragment = run_agent(cfg, prompt)
        if fragment["status"] == "EXECUTED":
            outcome = "RESEARCH_DONE"
        elif fragment["status"] == "TIMEOUT":
            outcome = "RESEARCH_TIMEOUT"
        else:
            outcome = "RESEARCH_FAILED"
        receipt = build_receipt(cfg, data, outcome, {
            "prompt_tail": prompt[-500:],
            "commission_kind": "research",
            **fragment,
        })
        write_receipt(cfg, receipt)
        LOG.info("research %s → %s", directive_id, outcome)
        return

    # EXECUTE
    prompt = build_prompt(cfg, data)
    if cfg.dry_run:
        receipt = build_receipt(cfg, data, "DRY_RUN", {
            "note": "BRIDGE_DRY_RUN=1 — agent not invoked",
            "prompt": prompt,
        })
        write_receipt(cfg, receipt)
        LOG.info("dry-run: would execute %s (%d chars)", directive_id, len(prompt))
        return

    fragment = run_agent(cfg, prompt)
    receipt = build_receipt(cfg, data, fragment["status"], {
        "prompt_tail": prompt[-500:],
        **fragment,
    })
    write_receipt(cfg, receipt)
    LOG.info("directive %s → %s", directive_id, fragment["status"])


def collect_pending(cfg: BridgeConfig) -> list[Path]:
    if not cfg.directives.is_dir():
        return []
    return sorted(
        p for p in cfg.directives.iterdir()
        if p.is_file() and p.suffix == ".json" and not p.name.startswith(".")
    )


def main(argv: list[str]) -> int:
    logging.basicConfig(
        level=getattr(logging, env_setting("BRIDGE_LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    cfg = BridgeConfig()
    cfg.ensure_dirs()

    if "--check" in argv:
        print(cfg.describe())
        print("directories:", "ok" if cfg.directives.is_dir() and cfg.executions.is_dir() else "MISSING")
        if "--probe" in argv:
            code, detail = probe_llm_gateway()
            print(f"probe: HTTP {code}" + (f" — {detail}" if detail else ""))
            return 0 if code == 200 else 1
        return 0

    if "--file" in argv:
        index = argv.index("--file")
        if index + 1 >= len(argv):
            LOG.error("--file requires a path")
            return 2
        target = Path(argv[index + 1])
        if not target.is_file():
            LOG.error("no such file: %s", target)
            return 2
        process_file(cfg, target)
        return 0

    if "--once" in argv:
        for path in collect_pending(cfg):
            process_file(cfg, path)
        return 0

    # Default: watch loop.
    halt_file = cfg.home / "halt"
    LOG.info("directive-bridge watching %s", cfg.directives)
    while True:
        if halt_file.exists():
            LOG.warning("halt file present (%s); standing down", halt_file)
            time.sleep(cfg.poll_s)
            continue
        for path in collect_pending(cfg):
            try:
                process_file(cfg, path)
            except Exception:  # noqa: BLE001 — never let one file kill the loop
                LOG.exception("failed to process %s", path)
        time.sleep(cfg.poll_s)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))