# directive-bridge — Hermès ⇄ Vibe-Trading execution bridge (fork-owned,
# deploy/oci/bridge).
#
# Reuses the locally built vibe-trading:arm64 image so the directive is
# executed by the SAME Python runtime, connector config and credentials as
# the main vibe-trading service (shared vibe_data volume): the bridge invokes
# `vibe-trading -p ... --json`, the same headless agent path the operator
# would use by hand. No Docker socket, no MCP order tools (upstream MCP
# exposes none by design) — the agent's internal `trading_place_order` is
# the only order surface, and it stays fail-closed behind its mandate.
#
# Ring-buffer exchange with Hermès via the bridge_data volume:
#   /var/lib/bridge/directives   (owned uid 1000 = Hermès writes here)
#   /var/lib/bridge/executions   (owned by the runtime user = bridge writes)
#   /var/lib/bridge/audit        (same)
# Fresh named volumes inherit these in-image owners, so no chown at runtime.

FROM vibe-trading:arm64

ENV TZ=UTC \
    BRIDGE_HOME=/var/lib/bridge \
    BRIDGE_POLL_S=15 \
    BRIDGE_MAX_ITER=30 \
    BRIDGE_TIMEOUT_S=900 \
    BRIDGE_CONNECTOR=alpaca-paper-trade \
    # Research commissions (mode: RESEARCH) are read-only agent runs, gated
    # OFF by default: parked as GATED receipts until the operator opts in.
    BRIDGE_ALLOW_RESEARCH=0

WORKDIR /app

COPY deploy/oci/bridge/bridge.py ./

# The runtime user inside the vibe-trading image is `vibe`; Hermès runs as
# uid 1000 (HERMES_UID default). Keep the exchange ring-buffer writable by
# both: directives/ belongs to Hermès (1000), the rest to the runtime user.
RUN mkdir -p /var/lib/bridge/directives \
             /var/lib/bridge/executions \
             /var/lib/bridge/audit \
    && chown -R vibe:vibe /var/lib/bridge \
    && chmod 0755 /var/lib/bridge/directives \
    && chown 1000:1000 /var/lib/bridge/directives \
    && chmod 0700 /var/lib/bridge/executions

# Exchange volume (directives in, receipts out, audit trail).
VOLUME ["/var/lib/bridge"]

# One-shot diagnostics (args append to the ENTRYPOINT):
#   docker compose run --rm bridge --check
#   docker compose run --rm -e BRIDGE_DRY_RUN=1 bridge --once
USER vibe
ENTRYPOINT ["python", "/app/bridge.py"]
CMD ["--loop"]