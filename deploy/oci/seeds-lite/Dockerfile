# seeds-lite — keyless seeder loop for the WorldMonitor fork (OCI Ampere A1).
#
# Runs a subset of scripts/seed-*.mjs on a staggered loop and writes into the
# fork's Upstash Redis, so the Vercel MCP data tools serve fresh data without
# the operator's Railway relay. Keyless by construction: ACLED, FRED, Finnhub
# and other credential-gated feed code paths are simply never scheduled.
#
# The ONLY external npm dependency the scheduled seeders import is papaparse
# (scripts/_conflict-hapi.mjs). It is pure JS, so a full `npm ci` (the whole
# frontend prod tree, possible native builds on alpine) is deliberately not
# done here.

FROM node:24-alpine

ENV TZ=UTC \
    NODE_ENV=production

# tzdata keeps date -u timestamps clean even when TZ changes; busybox provides
# timeout(1), date(1), tail(1). The base image already ships a non-root
# `node` user (uid 1000) — reuse it rather than creating a duplicate.
RUN apk add --no-cache tzdata

WORKDIR /app

# Seeder sources and the package manifests (for the single runtime dep).
COPY scripts/ ./scripts/
COPY package.json package-lock.json ./

# Install precisely the runtime dep the seeders import; --no-save keeps the
# copied package.json untouched in the image.
RUN npm install --omit=dev --no-audit --no-fund --no-save papaparse@^5.5.3 \
    && rm -rf /root/.npm /tmp/*

COPY deploy/oci/seeds-lite/run-seeds.sh /usr/local/bin/run-seeds.sh
RUN chmod +x /usr/local/bin/run-seeds.sh \
    && mkdir -p /var/lib/seeds-lite \
    && chown -R node:node /app /var/lib/seeds-lite

# Per-seed state (last-run timestamps, capped output logs). A fresh named
# volume inherits this ownership from the image directory.
VOLUME ["/var/lib/seeds-lite"]

USER node
ENTRYPOINT ["/usr/local/bin/run-seeds.sh"]