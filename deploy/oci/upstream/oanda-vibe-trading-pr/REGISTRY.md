# Registering the OANDA connector (3 one-line edits)

The connector is three new files (already in `agent/` in this package).
Registering it upstream needs exactly these edits in two existing files.
All anchors below are copied verbatim from `HKUDS/Vibe-Trading@main`
(2026-09-07).

## 1. `agent/src/trading/profiles.py`

Add the import, alphabetically between the `okx` and `robinhood` imports:

```python
from src.trading.connectors.okx.profiles import OKX_PROFILES
from src.trading.connectors.oanda.profiles import OANDA_PROFILES   # <-- add
from src.trading.connectors.robinhood.profiles import ROBINHOOD_PROFILES
```

Add the profile tuple to `BUILTIN_PROFILES`, e.g. after `*OKX_PROFILES,`:

```python
    *OKX_PROFILES,
    *OANDA_PROFILES,   # <-- add
    *BINANCE_PROFILES,
```

## 2. `agent/src/trading/service.py`

Add the SDK module mapping, alphabetically after the `okx` entry:

```python
    "okx": "src.trading.connectors.okx.sdk",
    "oanda": "src.trading.connectors.oanda.sdk",   # <-- add
    "binance": "src.trading.connectors.binance.sdk",
```

Add the mandate-gate instrument/asset-class classification, after `okx`:

```python
    "okx": ("crypto", "crypto"),
    "oanda": ("forex", "forex"),   # <-- add
    "binance": ("crypto", "crypto"),
```

`("forex", "forex")` mirrors how the `mt5` connector classifies forex
pairs (`InstrumentType.FOREX` / `AssetClass.FOREX`); if the upstream enum
ever renames those, align this entry with `classify_mt5_symbol`'s return.

## 3. Optional follow-up (not required for the connector to work)

Add an OANDA credential catalog entry in `agent/src/trading/connections.py`
so the Web UI connection forms show `api_key` + `account_id` fields for the
four `oanda-*` profiles. The legacy `~/.vibe-trading/oanda.json` config
path (mirroring `alpaca.json`) works without it.

## Verify

```bash
python -m compileall agent/src/trading/connectors/oanda
pip install -e ".[dev]"   # or the repo's documented dev install
vibe-trading connector check oanda-practice-trade   # after configuring oanda.json
vibe-trading connector list
```