#!/usr/bin/env bash
# ============================================================================
# OCI Ampere A1 — Bootstrap script for Vibe-Trading (Docker)
# ============================================================================
# Hermes is already installed natively on this instance.
# This installs Docker (if missing) and prepares Vibe-Trading.
#
# Usage:
#   scp -r deploy/oci ubuntu@<ip>:~/vibe-trading
#   ssh ubuntu@<ip>
#   cd ~/vibe-trading && bash setup.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  Vibe-Trading Setup — OCI Ampere A1 (free-tier)${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""

# ---- 1. Architecture check ----
echo -e "${YELLOW}[1/6] Checking architecture...${NC}"
ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ]; then
    echo -e "${RED}  ERROR: ARM64 required. Detected: ${ARCH}${NC}"
    exit 1
fi
CPUS=$(nproc)
RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
RAM_GB=$((RAM_KB / 1024 / 1024))
echo -e "  ${GREEN}ARM64 ✓  |  CPUs: ${CPUS}  |  RAM: ${RAM_GB} GB${NC}"
if [ "$RAM_GB" -lt 6 ]; then
    echo -e "${RED}  WARNING: <6 GB RAM. Heavy backtests will be tight.${NC}"
fi

# ---- 2. Docker install ----
echo -e "${YELLOW}[2/6] Checking Docker...${NC}"
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    sudo usermod -aG docker "$USER"
    echo -e "${YELLOW}  Docker installed. Log out and back in, then re-run setup.sh.${NC}"
    exit 0
fi
echo -e "  ${GREEN}$(docker --version)${NC}"

# ---- 3. Port check ----
echo -e "${YELLOW}[3/6] Checking ports...${NC}"
CONFLICT=""
if ss -tlnp 2>/dev/null | grep -q ':8899 '; then
    CONFLICT="8899 (Vibe-Trading UI)"
fi
if ss -tlnp 2>/dev/null | grep -q ':8082 '; then
    CONFLICT="$CONFLICT 8082 (FCC proxy)"
fi
if [ -n "$CONFLICT" ]; then
    echo -e "${RED}  WARNING: Ports in use:${CONFLICT}${NC}"
    echo -e "${RED}  Check for conflicts before starting.${NC}"
else
    echo -e "  ${GREEN}Ports 8899, 8082 free ✓${NC}"
fi

# ---- 4. Prepare .env ----
echo -e "${YELLOW}[4/6] Preparing .env...${NC}"
if [ -f "$SCRIPT_DIR/env.template" ]; then
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        cp "$SCRIPT_DIR/env.template" "$SCRIPT_DIR/.env"
        echo -e "  ${GREEN}Created .env from template.${NC}"
    else
        echo -e "  ${GREEN}.env already exists.${NC}"
    fi
else
    echo -e "${RED}  ERROR: env.template not found in $SCRIPT_DIR${NC}"
    exit 1
fi

# ---- 5. FCC (free-claude-code) optional install ----
echo -e "${YELLOW}[5/6] FCC safety-net proxy...${NC}"
echo -e "  FCC (free-claude-code) provides automatic fallback across 50+ free providers."
echo -e "  It requires Python 3.14+ and ~500 MB RAM."
echo ""
if command -v fcc-server &>/dev/null; then
    echo -e "  ${GREEN}FCC already installed: $(fcc-server --version 2>/dev/null || echo 'ok')${NC}"
else
    echo -e "  ${YELLOW}To install FCC now (recommended):${NC}"
    echo -e "    curl -fsSL 'https://raw.githubusercontent.com/Alishahryar1/free-claude-code/main/scripts/install.sh' | sh"
    echo -e "  ${YELLOW}To skip and install later: press Enter${NC}"
fi
echo ""

# ---- 6. Summary ----
echo -e "${YELLOW}[6/6] Done.${NC}"
echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}  Next steps${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""
echo -e "  ${YELLOW}1. Edit .env — set your DeepSeek API key:${NC}"
echo -e "     nano .env"
echo -e "     # DEEPSEEK_API_KEY=sk-...  (get one at https://platform.deepseek.com/api_keys)"
echo ""
echo -e "  ${YELLOW}2. Build and start Vibe-Trading:${NC}"
echo -e "     docker compose up -d --build"
echo -e "     ${GREEN}(first build: ~10–15 min on Ampere A1)${NC}"
echo ""
echo -e "  ${YELLOW}3. Check it's running:${NC}"
echo -e "     docker compose ps"
echo -e "     docker compose logs -f vibe-trading"
echo ""
echo -e "  ${YELLOW}4. Open the UI:${NC}"
echo -e "     http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<instance-ip>'):8899"
echo ""
echo -e "  ${GREEN}============================================================${NC}"
echo -e "  ${GREEN}  Hermes fallback setup (on the host, not Docker)${NC}"
echo -e "  ${GREEN}============================================================${NC}"
echo ""
echo -e "  Configure Hermes fallback chain (free-tier):"
echo -e "     hermes fallback add deepseek deepseek-chat"
echo -e "     hermes fallback add gemini models/gemini-2.5-flash"
echo -e "     hermes fallback add opencode-free default"
echo -e "     hermes fallback list"
echo ""
echo -e "  ${GREEN}============================================================${NC}"
echo -e "  ${GREEN}  Adding FCC safety net (optional)${NC}"
echo -e "  ${GREEN}============================================================${NC}"
echo ""
echo -e "  When FCC is installed and running (fcc-server),"
echo -e "  switch Vibe-Trading to use it as proxy:"
echo -e ""
echo -e "     # In .env, change:"
echo -e "     VIBE_TRADING_PROVIDER=openrouter"
echo -e "     OPENROUTER_API_KEY=fcc-proxy"
echo -e "     OPENROUTER_BASE_URL=http://localhost:8082"
echo ""
echo -e "  ${GREEN}============================================================${NC}"
echo -e "  ${GREEN}  Resource adjustment${NC}"
echo -e "  ${GREEN}============================================================${NC}"
echo ""
echo -e "  To adjust CPU/RAM limits: edit the 'deploy:' block in"
echo -e "  docker-compose.yml, then:  docker compose up -d"
echo ""
echo -e "  View logs:  docker compose logs -f vibe-trading"
echo ""