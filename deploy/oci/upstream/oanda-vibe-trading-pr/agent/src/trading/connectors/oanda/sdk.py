"""OANDA connector via the v20 REST API (stdlib only, no SDK dependency).

Implements the uniform ``broker_sdk`` interface used by
``src.trading.service``: ``build_config`` / ``check_status`` /
``get_account_snapshot`` / ``get_positions`` / ``get_open_orders`` /
``get_quote`` / ``get_historical_bars`` / ``place_order`` /
``cancel_order``. Reads and writes go straight to the v20 REST endpoints
with the official bearer-token auth header; no third-party package is
required, so this connector works in any environment the core package
runs in.

Practice-vs-live is structural: a practice profile connects to
``api-fxpractice.oanda.com`` with the fxTrade Practice token, a live
profile to ``api-fxtrade.oanda.com`` with the live token. The two key
pairs are minted separately (fxTrade Practice API access vs fxTrade API
access) and a practice token cannot reach the live host, so a paper
profile can never touch real funds. The configured ``profile`` is
recorded on every payload and never flipped implicitly.

Instruments use OANDA's canonical form (``EUR_USD``, ``USD_JPY``,
``BTC_USD``). Sizes are signed units in the base currency; OANDA accepts
fractional units where the instrument's tradeable unit allows it, which
lets callers respect tight notional caps instead of rounding up.
"""

from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping

from src.config.paths import get_runtime_root

CONFIG_FILENAME = "oanda.json"

#: Profiles this connector understands and their account environment.
PROFILE_ENVIRONMENTS = {
    "practice": "paper",
    "live": "live",
}

PRACTICE_HOST = "https://api-fxpractice.oanda.com"
LIVE_HOST = "https://api-fxtrade.oanda.com"


class OandaConfigError(RuntimeError):
    """Raised when the connector configuration is missing or invalid."""


class OandaApiError(RuntimeError):
    """Raised when the OANDA v20 API rejects a request.

    Carries the HTTP status and the v20 ``errorMessage`` (redacted of
    nothing — OANDA bodies never echo credentials).
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"OANDA v20 HTTP {status}: {message}")
        self.status = status
        self.message = message


@dataclass(frozen=True)
class OandaConfig:
    """OANDA connector connection settings.

    Args:
        api_key: OANDA v20 personal access token (practice or live, minted
            separately in fxTrade).
        account_id: Numeric OANDA account id (one token can see several
            accounts; the account id pins which one is used).
        profile: ``practice`` or ``live``.
        timeout: Network timeout in seconds.
        readonly: Always true for this layer; order methods are not exposed.
    """

    api_key: str = ""
    account_id: str = ""
    profile: str = "practice"
    timeout: float = 15.0
    readonly: bool = True

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any] | None = None) -> "OandaConfig":
        """Build a config from a JSON-like mapping, normalizing the profile."""
        payload = dict(data or {})
        profile = str(payload.get("profile") or "practice").strip().lower()
        if profile not in PROFILE_ENVIRONMENTS:
            raise OandaConfigError("profile must be 'practice' or 'live'")
        return cls(
            api_key=str(payload.get("api_key") or "").strip(),
            account_id=str(payload.get("account_id") or "").strip(),
            profile=profile,
            timeout=float(payload.get("timeout") or 15.0),
            readonly=bool(payload.get("readonly", True)),
        )

    def with_overrides(
        self,
        *,
        api_key: str | None = None,
        account_id: str | None = None,
        profile: str | None = None,
    ) -> "OandaConfig":
        """Return a copy with CLI/tool overrides applied."""
        payload = asdict(self)
        if api_key is not None:
            payload["api_key"] = api_key
        if account_id is not None:
            payload["account_id"] = account_id
        if profile is not None:
            payload["profile"] = profile
        return OandaConfig.from_mapping(payload)

    @property
    def environment(self) -> str:
        """Return ``paper`` or ``live`` for this profile."""
        return PROFILE_ENVIRONMENTS.get(self.profile, "paper")

    @property
    def is_practice(self) -> bool:
        """Return whether this profile targets the practice host/token."""
        return self.environment == "paper"

    @property
    def host(self) -> str:
        """Return the REST host this profile connects to."""
        return PRACTICE_HOST if self.is_practice else LIVE_HOST


_OVERRIDE_KEYS = ("api_key", "account_id", "profile")


def build_config(
    profile_config: Mapping[str, Any] | None = None,
    overrides: Mapping[str, Any] | None = None,
) -> "OandaConfig":
    """Resolve config: saved file ← profile defaults ← CLI overrides."""
    base = asdict(load_config())
    for key, value in dict(profile_config or {}).items():
        if value is not None:
            base[key] = value
    cfg = OandaConfig.from_mapping(base)
    clean = {
        k: v
        for k, v in dict(overrides or {}).items()
        if k in _OVERRIDE_KEYS and v not in (None, "")
    }
    return cfg.with_overrides(**clean) if clean else cfg


def config_path() -> Path:
    """Return the user-level OANDA config path."""
    return get_runtime_root() / CONFIG_FILENAME


def load_config() -> OandaConfig:
    """Load OANDA settings from ``~/.vibe-trading/oanda.json``."""
    path = config_path()
    if not path.exists():
        return OandaConfig()
    try:
        return OandaConfig.from_mapping(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise OandaConfigError(f"invalid OANDA config at {path}: {exc}") from exc


def save_config(config: OandaConfig) -> Path:
    """Persist OANDA settings with owner-only permissions."""
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(asdict(config), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


# ---------------------------------------------------------------------------
# v20 REST plumbing (stdlib only)
# ---------------------------------------------------------------------------


def _headers(config: OandaConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _request(
    config: OandaConfig,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Perform one v20 request and return the parsed JSON object.

    Raises:
        OandaApiError: On any HTTP error or non-JSON response. Callers that
            must fail closed (place_order / cancel_order) catch it; read
            paths let it propagate so the service layer reports a real
            failure instead of a misleading empty result.
    """
    url = f"{config.host}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers=_headers(config),
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=config.timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        detail = "unknown error"
        try:
            payload = json.loads(raw)
            detail = str(_obj_get(payload, "errorMessage") or detail)
        except (ValueError, TypeError):
            if raw.strip():
                detail = raw[:200]
        raise OandaApiError(exc.code, detail) from exc
    except urllib.error.URLError as exc:
        raise OandaApiError(0, f"network error: {exc.reason}") from exc
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise OandaApiError(0, f"non-JSON response: {exc}") from exc
    if not isinstance(payload, dict):
        raise OandaApiError(0, f"unexpected response shape: {type(payload).__name__}")
    return payload


def check_status(config: OandaConfig | None = None) -> dict[str, Any]:
    """Check config completeness and account reachability without mutating state."""
    cfg = config or load_config()
    report: dict[str, Any] = {
        "status": "ok",
        "config": _public_config(cfg),
        "sdk": {"package": "oanda-v20-rest", "installed": True},
        "paper_guard": "host_separated",
        "host": cfg.host,
    }
    missing = _missing_fields(cfg)
    if missing:
        report["status"] = "error"
        report["error"] = f"OANDA connector not configured: missing {', '.join(missing)}."
        return report
    try:
        snapshot = get_account_snapshot(cfg)
    except Exception as exc:  # noqa: BLE001 - health endpoint reports cleanly
        report["status"] = "error"
        report["error"] = str(exc)
        return report
    report["account"] = {
        "profile": cfg.profile,
        "is_practice": cfg.is_practice,
        "account_id": _obj_get(snapshot, "account", {}).get("id"),
    }
    return report


def get_account_snapshot(config: OandaConfig | None = None) -> dict[str, Any]:
    """Fetch the account summary for the configured account."""
    cfg = config or load_config()
    payload = _request(cfg, "GET", f"/v3/accounts/{cfg.account_id}/summary")
    account = payload.get("account") or {}
    return {
        "status": "ok",
        "profile": cfg.profile,
        "is_practice": cfg.is_practice,
        "host": cfg.host,
        "account": {
            "id": _obj_get(account, "id"),
            "currency": _obj_get(account, "currency"),
            "balance": _obj_get(account, "balance"),
            "nav": _obj_get(account, "NAV"),
            "margin_available": _obj_get(account, "marginAvailable"),
            "unrealized_pl": _obj_get(account, "unrealizedPL"),
            "realized_pl": _obj_get(account, "realizedPL"),
            "open_trade_count": _obj_get(account, "openTradeCount"),
            "open_position_count": _obj_get(account, "openPositionCount"),
            "open_order_count": _obj_get(account, "openOrderCount"),
            "margin_call_state": _obj_get(account, "marginCallEnterTime"),
            "trading_blocked": _obj_get(account, "tradingHalted"),
        },
    }


def get_positions(config: OandaConfig | None = None) -> dict[str, Any]:
    """Fetch current open positions for the configured account."""
    cfg = config or load_config()
    payload = _request(cfg, "GET", f"/v3/accounts/{cfg.account_id}/positions")
    rows: list[dict[str, Any]] = []
    for item in payload.get("positions") or []:
        instrument = str(_obj_get(item, "instrument", "")).strip().upper()
        long_leg = item.get("long") if isinstance(item.get("long"), dict) else {}
        short_leg = item.get("short") if isinstance(item.get("short"), dict) else {}
        long_units = _to_float(_obj_get(long_leg, "units"))
        short_units = _to_float(_obj_get(short_leg, "units"))
        quantity = (long_units or 0.0) - (abs(short_units) if short_units else 0.0)
        average_price = _obj_get(long_leg, "averagePrice") or _obj_get(
            short_leg, "averagePrice"
        )
        unrealized_pl = _obj_get(long_leg, "unrealizedPL") or _obj_get(
            short_leg, "unrealizedPL"
        )
        if instrument and quantity:
            rows.append(
                {
                    "symbol": instrument,
                    "quantity": quantity,
                    "side": "long" if quantity > 0 else "short",
                    "average_price": average_price,
                    "unrealized_pl": unrealized_pl,
                }
            )
    return {
        "status": "ok",
        "profile": cfg.profile,
        "is_practice": cfg.is_practice,
        "positions": rows,
    }


def get_open_orders(
    config: OandaConfig | None = None, *, include_executions: bool = False
) -> dict[str, Any]:
    """Fetch pending orders and, optionally, recently closed trades (fills)."""
    cfg = config or load_config()
    payload = _request(
        cfg, "GET", f"/v3/accounts/{cfg.account_id}/orders?state=PENDING"
    )
    result: dict[str, Any] = {
        "status": "ok",
        "profile": cfg.profile,
        "is_practice": cfg.is_practice,
        "open_orders": [
            _order_to_dict(item)
            for item in _as_iter(payload.get("orders"))
        ],
    }
    if include_executions:
        trades = []
        try:
            fills = _request(
                cfg,
                "GET",
                f"/v3/accounts/{cfg.account_id}/trades?state=CLOSED&count=20",
            )
            trades = [
                _trade_to_dict(item) for item in _as_iter(fills.get("trades"))
            ]
        except OandaApiError:
            # Fills are best-effort; the open-orders half is authoritative.
            trades = []
        result["executions"] = trades
    return result


def get_quote(
    symbol: str, *, config: OandaConfig | None = None, **_: Any
) -> dict[str, Any]:
    """Fetch a latest quote snapshot for ``symbol`` (OANDA form, e.g. EUR_USD)."""
    cfg = config or load_config()
    clean = str(symbol or "").strip().upper()
    if not clean:
        return {"status": "error", "error": "symbol is required"}
    payload = _request(
        cfg,
        "GET",
        f"/v3/accounts/{cfg.account_id}/pricing?instruments={clean}",
    )
    prices = _as_iter(payload.get("prices"))
    price = prices[0] if prices else {}
    bids = _as_iter(price.get("bids"))
    asks = _as_iter(price.get("asks"))
    return {
        "status": "ok",
        "symbol": clean,
        "quote": {
            "bid": _obj_get(bids[0], "price") if bids else None,
            "ask": _obj_get(asks[0], "price") if asks else None,
            "bid_size": _obj_get(bids[0], "liquidity") if bids else None,
            "ask_size": _obj_get(asks[0], "liquidity") if asks else None,
            "time": str(_obj_get(price, "time", "")),
        },
    }


_PERIOD_TO_GRANULARITY = {
    "1m": "M1",
    "5m": "M5",
    "15m": "M15",
    "30m": "M30",
    "1h": "H1",
    "1H": "H1",
    "4h": "H4",
    "4H": "H4",
    "1d": "D",
    "1w": "W",
    "1W": "W",
    "1M": "M",
}


def get_historical_bars(
    symbol: str,
    *,
    config: OandaConfig | None = None,
    period: str = "1d",
    limit: int = 90,
    **_: Any,
) -> dict[str, Any]:
    """Fetch historical mid candles for ``symbol`` (``period`` is a canonical token)."""
    cfg = config or load_config()
    clean = str(symbol or "").strip().upper()
    if not clean:
        return {"status": "error", "error": "symbol is required"}
    granularity = _PERIOD_TO_GRANULARITY.get(period.strip(), "D")
    payload = _request(
        cfg,
        "GET",
        f"/v3/instruments/{clean}/candles"
        f"?granularity={granularity}&count={int(limit)}&price=M",
    )
    rows: list[dict[str, Any]] = []
    for candle in _as_iter(payload.get("candles")):
        mid = candle.get("mid") if isinstance(candle.get("mid"), dict) else {}
        rows.append(
            {
                "time": str(_obj_get(candle, "time", "")),
                "open": _to_float(_obj_get(mid, "o")),
                "high": _to_float(_obj_get(mid, "h")),
                "low": _to_float(_obj_get(mid, "l")),
                "close": _to_float(_obj_get(mid, "c")),
                "volume": _to_float(_obj_get(candle, "volume")),
                "complete": bool(_obj_get(candle, "complete", False)),
            }
        )
    return {
        "status": "ok",
        "symbol": clean,
        "period": period,
        "granularity": granularity,
        "bars": rows,
    }


def place_order(
    config: OandaConfig | None = None,
    *,
    symbol: str,
    side: str,
    quantity: float | None = None,
    notional: float | None = None,
    order_type: str = "market",
    limit_price: float | None = None,
    time_in_force: str = "day",
    client_order_id: str | None = None,
) -> dict[str, Any]:
    """Submit an order to the configured OANDA account.

    Paper-vs-live is structural: ``cfg.host`` is the practice host for a
    practice profile and the live host for a live profile; the token in
    ``cfg.api_key`` can only authenticate on the host it was minted for.
    This connector only executes against the account in ``config``;
    deciding whether the order is authorized (mandate, kill switch, user
    opt-in) is the caller's responsibility.

    OANDA sizes orders in signed units of the base currency (positive
    long / negative short); fractional units are accepted where the
    instrument's tradeable unit allows it. Notional is not a v20 order
    parameter for spot FX, so ``notional`` is rejected — pass ``quantity``
    in base-currency units.

    Returns:
        On success ``{"status": "ok", "order_id", "symbol", "side",
        "profile", "is_practice", "order_type", "time_in_force",
        "quantity", "limit_price", "order_status", "filled_qty"}``. On
        invalid input or submission failure ``{"status": "error",
        "error": <message>}`` — fails closed, never raises.
    """
    cfg = config or load_config()
    clean_symbol = str(symbol or "").strip().upper()
    if not clean_symbol:
        return {"status": "error", "error": "symbol is required"}
    side_token = str(side or "").strip().lower()
    if side_token not in ("buy", "sell"):
        return {"status": "error", "error": "side must be 'buy' or 'sell'"}
    type_token = str(order_type or "").strip().lower()
    if type_token not in ("market", "limit"):
        return {"status": "error", "error": "order_type must be 'market' or 'limit'"}
    if quantity is None:
        if notional is not None:
            return {
                "status": "error",
                "error": (
                    "notional is not supported by OANDA v20 spot; provide "
                    "quantity in base-currency units"
                ),
            }
        return {"status": "error", "error": "quantity is required"}
    try:
        qty_value = float(quantity)
    except (TypeError, ValueError):
        return {"status": "error", "error": "quantity must be numeric"}
    if not math.isfinite(qty_value) or qty_value <= 0:
        return {"status": "error", "error": "quantity must be a finite positive number"}
    limit_value: float | None = None
    if type_token == "limit":
        if limit_price is None:
            return {"status": "error", "error": "limit order requires limit_price"}
        try:
            limit_value = float(limit_price)
        except (TypeError, ValueError):
            return {"status": "error", "error": "limit_price must be numeric"}
        if not math.isfinite(limit_value) or limit_value <= 0:
            return {"status": "error", "error": "limit_price must be a finite positive number"}
    units = qty_value if side_token == "buy" else -qty_value
    # OANDA requires FOK time-in-force for MARKET orders; LIMIT rests as GTC.
    tif = "FOK" if type_token == "market" else "GTC"
    order: dict[str, Any] = {
        "type": "MARKET" if type_token == "market" else "LIMIT",
        "instrument": clean_symbol,
        "units": f"{units:.8f}".rstrip("0").rstrip("."),
        "timeInForce": tif,
    }
    if type_token == "limit":
        order["price"] = f"{limit_value:.8f}".rstrip("0").rstrip(".")
    body = {"order": order}
    try:
        payload = _request(
            cfg, "POST", f"/v3/accounts/{cfg.account_id}/orders", body=body
        )
    except OandaApiError as exc:
        return {"status": "error", "error": str(exc)}
    fill_txn = payload.get("orderFillTransaction")
    cancel_txn = payload.get("orderCancelTransaction")
    if isinstance(fill_txn, dict):
        trade_opened = fill_txn.get("tradeOpened") if isinstance(fill_txn.get("tradeOpened"), dict) else {}
        return {
            "status": "ok",
            "order_id": str(_obj_get(fill_txn, "id", "")),
            "client_order_id": client_order_id,
            "symbol": clean_symbol,
            "side": side_token,
            "profile": cfg.profile,
            "is_practice": cfg.is_practice,
            "order_type": type_token,
            "time_in_force": tif,
            "quantity": qty_value,
            "limit_price": limit_value,
            "order_status": "FILLED",
            "filled_qty": _to_float(_obj_get(trade_opened, "units")) or qty_value,
            "fill_price": _to_float(_obj_get(trade_opened, "price")),
        }
    if isinstance(cancel_txn, dict):
        return {
            "status": "error",
            "error": (
                "OANDA rejected the order: "
                f"{_obj_get(cancel_txn, 'reason', 'unknown reason')}"
            ),
            "order_status": "REJECTED",
        }
    return {
        "status": "ok",
        "order_id": str(_obj_get(payload, "orderCreateTransaction", {}).get("id", "")),
        "client_order_id": client_order_id,
        "symbol": clean_symbol,
        "side": side_token,
        "profile": cfg.profile,
        "is_practice": cfg.is_practice,
        "order_type": type_token,
        "time_in_force": tif,
        "quantity": qty_value,
        "limit_price": limit_value,
        "order_status": "SUBMITTED",
        "filled_qty": 0,
    }


def cancel_order(
    config: OandaConfig | None = None,
    order_id: str = "",
    *,
    symbol: str | None = None,
) -> dict[str, Any]:
    """Cancel a pending order on the configured OANDA account."""
    cfg = config or load_config()
    clean_id = str(order_id or "").strip()
    if not clean_id:
        return {"status": "error", "error": "order_id is required"}
    clean_symbol = symbol.strip().upper() if isinstance(symbol, str) and symbol.strip() else None
    try:
        payload = _request(
            cfg,
            "PUT",
            f"/v3/accounts/{cfg.account_id}/orders/{clean_id}/cancel",
        )
    except OandaApiError as exc:
        return {"status": "error", "error": str(exc)}
    cancel_txn = payload.get("orderCancelTransaction")
    return {
        "status": "ok",
        "order_id": str(_obj_get(cancel_txn, "orderID", clean_id)),
        "symbol": clean_symbol,
        "side": None,
        "profile": cfg.profile,
        "is_practice": cfg.is_practice,
        "cancelled": True,
    }


# ---------------------------------------------------------------------------
# Defensive field extraction
# ---------------------------------------------------------------------------


def _as_iter(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def _obj_get(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _order_to_dict(item: Any) -> dict[str, Any]:
    return {
        "order_id": str(_obj_get(item, "id", "")),
        "symbol": str(_obj_get(item, "instrument", "")).strip().upper(),
        "order_type": str(_obj_get(item, "type", "")).lower(),
        "time_in_force": str(_obj_get(item, "timeInForce", "")).lower(),
        "quantity": _to_float(_obj_get(item, "units")),
        "limit_price": _to_float(_obj_get(item, "price")),
        "order_status": str(_obj_get(item, "state", "")).lower(),
        "submitted_at": str(_obj_get(item, "createTime", "")),
    }


def _trade_to_dict(item: Any) -> dict[str, Any]:
    return {
        "trade_id": str(_obj_get(item, "id", "")),
        "symbol": str(_obj_get(item, "instrument", "")).strip().upper(),
        "quantity": _to_float(_obj_get(item, "units")),
        "price": _to_float(_obj_get(item, "price")),
        "realized_pl": _to_float(_obj_get(item, "realizedPL")),
        "open_time": str(_obj_get(item, "openTime", "")),
        "close_time": str(_obj_get(item, "closeTime", "")),
    }


def _missing_fields(cfg: OandaConfig) -> list[str]:
    missing = []
    if not cfg.api_key:
        missing.append("api_key")
    if not cfg.account_id:
        missing.append("account_id")
    return missing


def _public_config(cfg: OandaConfig) -> dict[str, Any]:
    """Config snapshot with secrets redacted."""
    data = asdict(cfg)
    if data.get("api_key"):
        data["api_key"] = data["api_key"][:6] + "***"
    data["host"] = cfg.host
    return data