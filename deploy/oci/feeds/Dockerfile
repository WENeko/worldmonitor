# feed-intel — dependency-free RSS/Atom/scrape poller for the Hermès Macro
# Director layer (fork-owned, deploy/oci/feeds).
#
# Polls the editable catalog (sources.json) on a loop and writes per-sector
# JSON snapshots + a per-source health file that Hermès uses to learn which
# sources are reliable. Node builtins only: no npm deps, no external APIs,
# no Redis writes — the output is plain JSON on a shared volume.
#
# sources.json is bind-mounted read-write from the host checkout at runtime
# (see docker-compose.yml) so the operator — or Hermès itself via its own
# mount — can add/disable/re-rate sources live. The loop re-reads the
# catalog at the top of every cycle; no restart needed.

FROM node:24-alpine

ENV TZ=UTC \
    NODE_ENV=production \
    FEED_SOURCES=/app/sources.json \
    FEED_STATE=/var/lib/feed-intel

# tzdata keeps timestamps clean; mirrors the seeds-lite image conventions.
RUN apk add --no-cache tzdata

WORKDIR /app

COPY deploy/oci/feeds/poll-feeds.mjs ./
COPY deploy/oci/feeds/sources.json ./
COPY deploy/oci/feeds/adapters/ ./adapters/

RUN mkdir -p /var/lib/feed-intel \
    && chown -R node:node /app /var/lib/feed-intel

# Snapshot/state output. A fresh named volume inherits this ownership.
VOLUME ["/var/lib/feed-intel"]

USER node

# One-shot validation: docker compose run --rm feed-intel node poll-feeds.mjs --check
CMD ["node", "poll-feeds.mjs", "--loop"]
