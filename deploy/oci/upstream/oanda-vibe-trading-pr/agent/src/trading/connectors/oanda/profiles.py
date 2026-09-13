"""Built-in OANDA connector profiles.

Layer A ships read-only practice and live profiles; the trade profiles add
order placement. Practice and live use different API tokens and different
hosts (``api-fxpractice.oanda.com`` vs ``api-fxtrade.oanda.com``), so they
are distinct profiles. The live-trade profile carries an
``orders.place.requires_mandate`` capability — placement on live funds is
only authorized once the caller has a mandate in place; this connector
layer just records the capability.

Instruments are OANDA canonical pairs (``EUR_USD``, ``USD_JPY``,
``BTC_USD``). Sizes are signed base-currency units; fractional units are
accepted where the instrument allows them.
"""

from __future__ import annotations

from src.trading.types import READ_CAPABILITIES, TradingProfile

OANDA_PROFILES: tuple[TradingProfile, ...] = (
    TradingProfile(
        id="oanda-practice-sdk",
        connector="oanda",
        label="OANDA fxTrade Practice · v20 REST",
        environment="paper",
        transport="broker_sdk",
        capabilities=READ_CAPABILITIES,
        readonly=True,
        config={"profile": "practice"},
        notes=(
            "Reads an OANDA fxTrade Practice account "
            "(api-fxpractice.oanda.com) via the v20 REST API. Practice "
            "tokens cannot reach the live host."
        ),
    ),
    TradingProfile(
        id="oanda-practice-trade",
        connector="oanda",
        label="OANDA fxTrade Practice · v20 REST Trade",
        environment="paper",
        transport="broker_sdk",
        capabilities=READ_CAPABILITIES + ("orders.place",),
        readonly=False,
        config={"profile": "practice"},
        notes=(
            "Reads and places orders on an OANDA fxTrade Practice account "
            "(api-fxpractice.oanda.com) via the v20 REST API. Practice "
            "tokens cannot reach the live host, so no order from this "
            "profile can touch real funds."
        ),
    ),
    TradingProfile(
        id="oanda-live-sdk-readonly",
        connector="oanda",
        label="OANDA fxTrade · v20 REST Read-Only",
        environment="live",
        transport="broker_sdk",
        capabilities=READ_CAPABILITIES,
        readonly=True,
        config={"profile": "live"},
        notes=(
            "Reads an OANDA fxTrade live account (api-fxtrade.oanda.com) "
            "only. Order placement is not exposed in this profile."
        ),
    ),
    TradingProfile(
        id="oanda-live-trade",
        connector="oanda",
        label="OANDA fxTrade · v20 REST Trade",
        environment="live",
        transport="broker_sdk",
        capabilities=READ_CAPABILITIES + ("orders.place.requires_mandate",),
        readonly=False,
        config={"profile": "live"},
        notes=(
            "Reads and places orders on an OANDA fxTrade live account "
            "(api-fxtrade.oanda.com). Placement on live funds requires an "
            "authorized mandate; the caller enforces it."
        ),
    ),
)