#!/usr/bin/env bash
# ============================================================================
# Vibe-Trading container entrypoint
# Runs BOTH processes in the same container:
#   1. Web UI + REST API   → 0.0.0.0:8899   (joignable par tunnel SSH ; les
#                                              requêtes non-loopback sont
#                                              refusées tant qu'API_AUTH_KEY
#                                              est vide — voir env.template)
#   2. MCP Streamable HTTP → 127.0.0.1:8900 (loopback uniquement — sécurité)
#
# Each process is wrapped in a restart loop: a crash restarts the process
# without killing the container (the container itself restarts only on
# image-level failure via `restart: unless-stopped`).
#
# Hermes (autre conteneur, réseau host) se connecte au MCP via:
#   http://127.0.0.1:8900/mcp   (config dans ~/.hermes/config.yaml)
# ============================================================================
set -euo pipefail

log() { echo "[entrypoint] $(date -u +%H:%M:%S) $*"; }

run_loop() {
  local name="$1"
  shift
  while :; do
    log "starting ${name}: $*"
    "$@" || log "${name} exited with status $?; restart in 3s"
    sleep 3
  done
}

# Web UI + REST API (bind 0.0.0.0 pour rester joignable dans le réseau host et
# par tunnel SSH sur :8899 ; le contrôle peer-IP de l'API refuse les requêtes
# non-loopback tant qu'API_AUTH_KEY est vide)
run_loop "serve" vibe-trading serve --host 0.0.0.0 --port 8899 &

# MCP server — Streamable HTTP (spec MCP actuelle).
# Reste en 127.0.0.1 (défaut + garde anti DNS-rebinding). Ne JAMAIS exposer
# en 0.0.0.0 : les outils MCP sont une surface d'exécution.
run_loop "mcp" vibe-trading-mcp --transport http &

wait
