# OANDA connector (fxTrade Practice + fxTrade) — v20 REST, zero new dependency

## Summary

Adds a `broker_sdk` connector for **OANDA** (retail forex / metals /
indices / crypto CFDs) using the official v20 REST API. Four profiles:

| Profile | Environment | Capabilities |
|---|---|---|
| `oanda-practice-sdk` | paper | read-only (account, positions, orders, quotes, history) |
| `oanda-practice-trade` | paper | reads + `orders.place` |
| `oanda-live-sdk-readonly` | live | read-only |
| `oanda-live-trade` | live | reads + `orders.place.requires_mandate` |

The practice profiles target `api-fxpractice.oanda.com` with a token
minted inside fxTrade **Practice**; the live profiles target
`api-fxtrade.oanda.com`. Practice tokens cannot authenticate on the live
host, so paper/live separation is structural (same pattern as the Alpaca
and Binance connectors).

## Why

Forex was added to the mandate-gate vocabulary in v0.1.12, but no
retail-forex broker connector exists yet — the closest is `mt5`, which is
Windows-only and excluded from the Linux image. OANDA is the standard
choice for a no-identity-document paper account: signing up for fxTrade
Practice (email + country, no ID/tax documents) mints API tokens
immediately, and the practice REST host is fully functional for
development and forward testing.

## Implementation notes

- **Zero new runtime dependency**: the connector talks to v20 REST with
  the standard library (`urllib`), unlike the SDK-based connectors. This
  is deliberate — OANDA's official `v20` python library is unmaintained,
  and a hand-rolled REST client is ~350 lines with a smaller footprint.
- **Auth**: single bearer token (`api_key`) plus the numeric `account_id`
  (one token can see several accounts). Config lives in
  `~/.vibe-trading/oanda.json` mirroring `alpaca.json`.
- **Sizing**: signed base-currency units (positive long / negative
  short); fractional units are passed through, which lets callers respect
  tight notional caps. `notional` is rejected (v20 has no notional field
  for spot orders) with a clear error.
- **Instrument form**: OANDA canonical pairs (`EUR_USD`, `USD_JPY`,
  `BTC_USD`). The mandate gate classifies them as forex.
- **Fills**: market orders use `timeInForce: FOK` (required by v20);
  `place_order` reports `order_status: FILLED` with the fill price when
  the response contains an `orderFillTransaction`, and fails closed with
  the v20 `reason` when the order was cancelled/rejected.
- Read endpoints map onto the shared `READ_CAPABILITIES` surface:
  account summary, positions (long/short legs normalized to signed
  quantity), pending orders + closed trades, pricing (bid/ask), mid
  candles (granularity mapped from the canonical period tokens).

## Test plan

1. `vibe-trading connector check oanda-practice-trade` — healthy with a
   practice token + account id in `~/.vibe-trading/oanda.json`.
2. `vibe-trading connector account` / `positions` / `quote EUR_USD` /
   `history EUR_USD --period 1h` against the practice profile.
3. Paper `place_order` (e.g. `EUR_USD` BUY 1000 market) on fxTrade
   Practice, then `positions` shows the fill; cancel a resting limit.
4. Confirm the live profiles refuse to place without a mandate (capability
   `orders.place.requires_mandate`).
5. Unit/edge coverage mirrors the Alpaca connector where the repo's
   existing test layout allows.

## Files

```
agent/src/trading/connectors/oanda/__init__.py
agent/src/trading/connectors/oanda/profiles.py
agent/src/trading/connectors/oanda/sdk.py
```

plus two one-line registry edits in `profiles.py` and `service.py` (see
REGISTRY.md in the source package).