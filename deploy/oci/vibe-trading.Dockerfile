# ============================================================================
# Vibe-Trading Docker image — linux/arm64 (OCI Ampere A1)
# ============================================================================
# Build: docker build -t vibe-trading:arm64 .
# The build clones Vibe-Trading from GitHub, installs deps, no local source needed.
#
# Runtime: the entrypoint runs TWO processes:
#   - vibe-trading serve  (Web UI + REST API)  → 0.0.0.0:8899
#   - vibe-trading-mcp --transport http        → 127.0.0.1:8900/mcp
#
# The Web UI is a separate React 19 / Vite build that is NOT part of the
# Python package (frontend/dist is gitignored, absent from the sdist/wheel and
# from MANIFEST.in). A plain `pip install` therefore leaves `serve` with an
# API but no UI — it prints "[warn] No frontend build found" and answers every
# page request with JSON. Stage 1 below builds those assets; the runtime stage
# drops them where the installed package looks for them.
# ============================================================================

# ============================================================================
# Stage 1: Web UI assets (React 19 + Vite)
# ============================================================================
# Mirrors upstream's own Dockerfile (frontend-build stage). The alternative —
# copying /app/frontend/dist out of the published ghcr.io/hkuds/vibe-trading
# image — would drag a multi-GB image in for a few static files, and that GHCR
# package is private by default.
FROM node:22-slim AS frontend-build

ARG VIBE_TRADING_VERSION=v0.1.14

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${VIBE_TRADING_VERSION}" \
    https://github.com/HKUDS/Vibe-Trading.git /src

WORKDIR /src/frontend
# npm ci (not install): package-lock.json is committed, so the UI build is
# reproducible against the pinned tag. --ignore-scripts keeps dependency
# lifecycle hooks out of the build, like the rest of this stack.
RUN npm ci --ignore-scripts && npm run build

# ============================================================================
# Stage 2: runtime
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

# Broker SDK for the alpaca connector (paper/live). The core package ships
# WITHOUT broker SDKs: every connector call fails with "alpaca-py is not
# installed; run pip install alpaca-py" until this is present. Separate RUN
# keeps the heavy vibe-trading layer above cached across image rebuilds.
# bridge (FROM vibe-trading:arm64) inherits this install too.
RUN pip install --no-cache-dir "alpaca-py"

# ccxt for the binance/okx connectors (spot testnet + live). At the tag pinned
# above ccxt is already a base dependency of vibe-trading-ai (pyproject.toml),
# so this RUN is belt-and-braces: it keeps the pin explicit and covers older
# tags. Unlike alpaca-py, a missing ccxt would surface as "ccxt is not
# installed" on the first binance/okx call.
RUN pip install --no-cache-dir "ccxt"

# Web UI assets, installed where the package resolves them. Both lookup sites
# derive the same directory from the installed layout:
#   api_server.serve_main  -> Path(api_server.__file__).parent.parent / "frontend" / "dist"
#   src/api/helpers.py     -> Path(helpers.__file__).parent x4 / "frontend" / "dist"
# which in this (non-editable) site-packages install is
# <prefix>/lib/python3.11/frontend/dist. The path is computed at build time
# rather than hardcoded, and `test -f index.html` fails the build loudly if a
# future release moves the lookup instead of shipping a UI-less image.
COPY --from=frontend-build /src/frontend/dist /opt/vibe-frontend/dist
RUN FRONTEND_DIR="$(python -c 'import site, pathlib; print(pathlib.Path(site.getsitepackages()[0]).parent / "frontend" / "dist")')" \
    && mkdir -p "$FRONTEND_DIR" \
    && cp -a /opt/vibe-frontend/dist/. "$FRONTEND_DIR/" \
    && test -f "$FRONTEND_DIR/index.html" \
    && chown -R vibe:vibe "$FRONTEND_DIR" \
    && rm -rf /opt/vibe-frontend \
    && echo "Web UI assets installed in $FRONTEND_DIR"

# Data directory (volume mount point)
RUN mkdir -p /home/vibe/.vibe-trading && chown -R vibe:vibe /home/vibe/.vibe-trading

# Entrypoint: runs `serve` (UI/API) + `mcp --transport http` (MCP server)
COPY vibe-trading-entrypoint.sh /usr/local/bin/vibe-trading-entrypoint.sh
RUN chmod +x /usr/local/bin/vibe-trading-entrypoint.sh && chmod 755 /usr/local/bin/vibe-trading-entrypoint.sh

USER vibe
WORKDIR /home/vibe
VOLUME /home/vibe/.vibe-trading

# Web UI (SPA served by `serve` from the assets installed above) + REST API,
# and MCP Streamable HTTP (loopback, intérieur réseau host)
EXPOSE 8899 8900

CMD ["vibe-trading-entrypoint.sh"]
