"""OANDA trading connector.

Read-only account/market access and order placement via the OANDA v20
REST API (``api-fxpractice.oanda.com`` / ``api-fxtrade.oanda.com``) using
the standard library only — no SDK dependency. A ``broker_sdk`` transport.

Practice-vs-live separation is structural: practice and live use DIFFERENT
API tokens and DIFFERENT hosts, so a practice token physically cannot
reach the live host. The configured ``profile`` (and thus the host) is the
authoritative discriminator; it is recorded on every payload and never
flipped implicitly.
"""