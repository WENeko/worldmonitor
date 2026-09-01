# ============================================================================
# Vibe-Trading Docker image — linux/arm64 (OCI Ampere A1)
# ============================================================================
# Build: docker build -t vibe-trading:arm64 .
# The build clones Vibe-Trading from GitHub, installs deps, no local source needed.
#
# Runtime: the entrypoint runs TWO processes:
#   - vibe-trading serve  (Web UI + REST API)  → 0.0.0.0:8899
#   - vibe-trading-mcp --transport http        → 127.0.0.1:8900/mcp
# ============================================================================

FROM python:3.11-slim

ARG VIBE_TRADING_VERSION=v0.1.14

# System deps for weasyprint (PDF reports) — harmless if not used.
# bash is required by the entrypoint restart loops.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libharfbuzz0b \
    libfontconfig1 \
    libgdk-pixbuf-2.0-0 \
    libcairo2 \
    fonts-dejavu-core \
    git \
    curl \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (matches Vibe-Trading conventions)
RUN groupadd -r vibe && useradd -r -g vibe -m -d /home/vibe vibe

# Install Vibe-Trading from GitHub release
# Exclude [smc] (Smart Money Concepts — numba/llvmlite ARM issues)
# Exclude [mt5] (MetaTrader 5 — Windows-only)
RUN pip install --no-cache-dir \
    "vibe-trading-ai @ git+https://github.com/HKUDS/Vibe-Trading.git@${VIBE_TRADING_VERSION}"

# Data directory (volume mount point)
RUN mkdir -p /home/vibe/.vibe-trading && chown -R vibe:vibe /home/vibe/.vibe-trading

# Entrypoint: runs `serve` (UI/API) + `mcp --transport http` (MCP server)
COPY vibe-trading-entrypoint.sh /usr/local/bin/vibe-trading-entrypoint.sh
RUN chmod +x /usr/local/bin/vibe-trading-entrypoint.sh && chmod 755 /usr/local/bin/vibe-trading-entrypoint.sh

USER vibe
WORKDIR /home/vibe
VOLUME /home/vibe/.vibe-trading

# Web UI + REST API, and MCP Streamable HTTP (loopback, intérieur réseau host)
EXPOSE 8899 8900

CMD ["vibe-trading-entrypoint.sh"]
