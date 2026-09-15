#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

printf '%b\n' "${GREEN}Trading stack setup — Hermes + Vibe-Trading + LiteLLM${NC}"

ARCH=$(uname -m)
if [ "$ARCH" != aarch64 ]; then
  printf '%b\n' "${RED}ARM64 required; detected ${ARCH}${NC}"
  exit 1
fi
RAM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
printf '%b\n' "${GREEN}ARM64 OK; RAM: ${RAM_GB} GB${NC}"

if ! command -v docker >/dev/null 2>&1; then
  printf '%b\n' "${YELLOW}Docker is missing. Install it with the official Docker instructions, then rerun this script.${NC}"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '%b\n' "${RED}Docker Compose v2 is required.${NC}"
  exit 1
fi

if [ -d "$HOME/.hermes" ]; then
  printf '%b\n' "${GREEN}Existing ~/.hermes found; it will be mounted into the container.${NC}"
  printf '%b\n' "${YELLOW}Stop native Hermes before starting Docker; never share this directory concurrently.${NC}"
else
  mkdir -p "$HOME/.hermes"
  printf '%b\n' "${YELLOW}Created ~/.hermes for a fresh Hermes profile.${NC}"
fi

# 5432 is the LiteLLM UI database (litellm-db), published on loopback only.
for port in 8899 8900 8642 9119 4000 5432; do
  if ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .; then
    printf '%b\n' "${YELLOW}Port ${port} is already in use; inspect it before starting the stack.${NC}"
  fi
done

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/env.template" "$SCRIPT_DIR/.env"
  printf 'HERMES_UID=%s\nHERMES_GID=%s\n' "$(id -u)" "$(id -g)" >> "$SCRIPT_DIR/.env"
  printf '%b\n' "${GREEN}Created .env. Fill provider keys and replace LITELLM_MASTER_KEY.${NC}"
else
  printf '%b\n' "${GREEN}.env already exists; leaving it untouched.${NC}"
fi

printf '%b\n' "${GREEN}Next steps:${NC}"
printf '%s\n' "1. Stop native Hermes and confirm ~/.hermes is not being written by another process."
printf '%s\n' "2. Edit .env; set LITELLM_MASTER_KEY and at least one provider key."
printf '%s\n' "3. Start: docker compose up -d --build"
printf '%s\n' "4. Check: docker compose ps && docker compose logs --tail=100 litellm vibe-trading hermes"
printf '%s\n' "   litellm-db must be healthy before litellm starts: the Admin UI cannot log anyone in without it."
printf '%s\n' "5. Test gateway locally: curl -fsS http://127.0.0.1:4000/health/liveliness"
printf '%s\n' "6. Merge hermes-config.yaml into ~/.hermes/config.yaml, then restart Hermes."
printf '%s\n' "7. Access the operator UIs. Never publish 8899, 8900, 4000, 8642 or 9119 on the OCI public IP."
printf '%s\n' "   Recommended — let this host serve them to your tailnet (no tunnel, no client-side script,"
printf '%s\n' "   no ingress change; derives API_ALLOWED_HOSTS, publishes 'tailscale serve', verifies HTTPS):"
printf '%s\n' "   bash tailscale/setup-tailscale.sh"
printf '%s\n' "   https://<node>.<tailnet>.ts.net/          Vibe-Trading Web UI"
printf '%s\n' "   https://<node>.<tailnet>.ts.net:8443/ui   LiteLLM Admin UI    (see tailscale/README.md)"
printf '%s\n' "   Fallback — SSH tunnels, when no tailnet is available:"
printf '%s\n' "   ssh -N -L 8899:127.0.0.1:8899 -L 4000:127.0.0.1:4000 ubuntu@<oci-host>"
printf '%s\n' "   Vibe-Trading Web UI: http://127.0.0.1:8899   LiteLLM Admin UI: http://127.0.0.1:4000/ui"
printf '%s\n' "   Use 127.0.0.1 (or localhost), never the OCI public IP: a non-loopback Host is rejected with 403."
printf '%s\n' "   A bare ssh tunnel dies on sleep, Wi-Fi changes and OCI reboots. To make it a service, copy"
printf '%s\n' "   deploy/oci/tunnel/ to the machine with the BROWSER (not this host) and run, once:"
printf '%s\n' "   bash install.sh ubuntu@<oci-host>      (Linux: systemd user unit, macOS: LaunchAgent)"
printf '%s\n' "   bash ocitunnel.sh --check              (prerequisites + ssh reachability; see tunnel/README.md)"
printf '%s\n' "8. Prove the Web UI is actually served (the pip package ships no frontend, so an image built"
printf '%s\n' "   without stage 1 answers API-only with a normal-looking container). Rebuilds vibe-trading and"
printf '%s\n' "   bridge, then checks the SPA shell, a hashed bundle, a deep link and the REST API:"
printf '%s\n' "   bash verify-ui.sh"
printf '%s\n' "Resource limits are adjustable in docker-compose.yml; rerun docker compose up -d afterward."
