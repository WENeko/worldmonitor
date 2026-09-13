"""Read-only local connector for OANDA fxTrade Practice (v20 REST).

Implements the three operations the local-plugin contract requires
(check_status / get_account_snapshot / get_positions) against the OANDA
v20 REST API with the stdlib only. Never adds order, transfer, withdrawal,
or credential logging code — this adapter is strictly read-only.

Credentials are injected by Vibe-Trading from the OS credential store:
``api_key`` (practice personal access token) and ``account_id``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Mapping

PRACTICE_HOST = "https://api-fxpractice.oanda.com"


def _request(
    credentials: Mapping[str, str],
    method: str,
    path: str,
) -> dict[str, Any]:
    """One v20 GET; raises on HTTP error so callers fail closed."""
    token = str(credentials.get("api_key") or "").strip()
    account_id = str(credentials.get("account_id") or "").strip()
    if not token or not account_id:
        raise RuntimeError("missing api_key or account_id credential")
    url = f"{PRACTICE_HOST}{path}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"OANDA v20 HTTP {exc.code}: {body[:200]}") from exc
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise RuntimeError(f"unexpected OANDA response shape: {type(payload).__name__}")
    return payload


def check_status(
    *, credentials: Mapping[str, str], config: Mapping[str, Any]
) -> dict[str, Any]:
    """Report configured/readiness without mutating broker state."""
    missing = [
        name
        for name in ("api_key", "account_id")
        if not str(credentials.get(name) or "").strip()
    ]
    if missing:
        return {
            "status": "error",
            "configured": False,
            "readonly": True,
            "missing_fields": missing,
        }
    try:
        snapshot = get_account_snapshot(credentials=credentials, config=config)
    except Exception as exc:  # noqa: BLE001 - health endpoint reports cleanly
        return {"status": "error", "configured": True, "readonly": True, "error": str(exc)}
    account = snapshot.get("account") or {}
    return {
        "status": "ok",
        "configured": True,
        "readonly": True,
        "host": PRACTICE_HOST,
        "account_id": account.get("id"),
        "is_practice": True,
    }


def get_account_snapshot(
    *, credentials: Mapping[str, str], config: Mapping[str, Any]
) -> dict[str, Any]:
    """Fetch the practice account summary."""
    account_id = str(credentials.get("account_id") or "").strip()
    payload = _request(
        credentials, "GET", f"/v3/accounts/{account_id}/summary"
    )
    account = payload.get("account") or {}
    return {
        "status": "ok",
        "is_practice": True,
        "host": PRACTICE_HOST,
        "account": {
            "id": account.get("id"),
            "currency": account.get("currency"),
            "balance": account.get("balance"),
            "nav": account.get("NAV"),
            "unrealized_pl": account.get("unrealizedPL"),
            "open_position_count": account.get("openPositionCount"),
        },
    }


def get_positions(
    *, credentials: Mapping[str, str], config: Mapping[str, Any]
) -> dict[str, Any]:
    """Fetch open positions, normalized to {symbol, quantity} rows."""
    account_id = str(credentials.get("account_id") or "").strip()
    payload = _request(
        credentials, "GET", f"/v3/accounts/{account_id}/positions"
    )
    rows: list[dict[str, Any]] = []
    for item in payload.get("positions") or []:
        instrument = str(item.get("instrument", "")).strip().upper()
        long_leg = item.get("long") if isinstance(item.get("long"), dict) else {}
        short_leg = item.get("short") if isinstance(item.get("short"), dict) else {}
        long_units = _to_float(long_leg.get("units"))
        short_units = _to_float(short_leg.get("units"))
        quantity = (long_units or 0.0) - (abs(short_units) if short_units else 0.0)
        if instrument and quantity:
            rows.append(
                {
                    "symbol": instrument,
                    "quantity": quantity,
                    "side": "long" if quantity > 0 else "short",
                    "average_price": long_leg.get("averagePrice")
                    or short_leg.get("averagePrice"),
                    "unrealized_pl": long_leg.get("unrealizedPL")
                    or short_leg.get("unrealizedPL"),
                }
            )
    return {"status": "ok", "is_practice": True, "positions": rows}


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None