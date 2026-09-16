#!/usr/bin/env bash
# ============================================================================
# push-contract.sh — put the repo's INTERFACE CONTRACT where Hermès reads it
# ============================================================================
# Run on the OCI host, from deploy/oci (invoke with bash, not ./):
#   bash bridge/push-contract.sh             # push + verify
#   bash bridge/push-contract.sh --check     # read-only: diff the two copies
#   bash bridge/push-contract.sh --dry-run   # print what would happen
#
# Why this exists
# ---------------
# The contract exists in exactly two places, and only the second one is read by
# the running system:
#   1. deploy/oci/bridge/hermes-contract.md            repo copy, source of truth
#   2. /opt/data/hermes/INTERFACE_CONTRACT.md          inside `hermes` — the path
#                                                      the contract's own
#                                                      "CONSIGNE DE PERSISTANCE"
#                                                      names as what the agent
#                                                      loads at session start.
# Two copies is already one too many, so this script keeps ONE name on each side
# and refuses to invent a third. (An intermediate /opt/data/contract-v4.md was
# used by hand during the bridge bring-up: nothing reads it, nothing checks it,
# and it is exactly the ambiguity this script removes.) `--check` diffs the two
# copies, so a stale or forked contract is a reported fact instead of a guess.
#
# Write path: `docker exec … cat > file`, not `docker cp`, not a host `cp`
# ------------------------------------------------------------------------
# ~/.hermes on the host belongs to HERMES_UID (the uid the container runs as),
# so a host-side `cp` fails with "Permission denied" for the `ubuntu` user —
# and `sudo` is the wrong fix here. `docker exec` writes as the container's own
# user, which is also the identity Hermès itself writes with, so the file keeps
# the ownership its rules require (rule: the agent persists the contract by
# REWRITING this file — a root-owned copy would make that step fail). A plain
# `docker cp` lands the file as root, hence the ownership fallback below.
#
# What this script does NOT do
# ----------------------------
# It only places the FILE. That is not the persistence step: the rules must also
# land in the agent's own storage, and only the agent can do that. The last line
# of every run prints the sentence to send it. Pushing the file without sending
# it leaves the file and the agent's memory on different revisions — the same
# drift in the other direction.
#
# Env overrides: HERMES_CONTAINER (hermes), HERMES_CONTRACT_PATH
#   (/opt/data/hermes/INTERFACE_CONTRACT.md), CONTRACT_FILE (<script dir>/hermes-contract.md),
#   LEGACY_MIRROR_PATH (/opt/data/contract-v4.md).
# Exit codes: 0 pushed or in sync; 1 out of sync, missing container, or failure;
#   2 usage error.
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACT_FILE="${CONTRACT_FILE:-$SCRIPT_DIR/hermes-contract.md}"
HERMES_CONTAINER="${HERMES_CONTAINER:-hermes}"
HERMES_CONTRACT_PATH="${HERMES_CONTRACT_PATH:-/opt/data/hermes/INTERFACE_CONTRACT.md}"
LEGACY_MIRROR_PATH="${LEGACY_MIRROR_PATH:-/opt/data/contract-v4.md}"

DO_CHECK=0; DO_DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --check)   DO_CHECK=1 ;;
    --dry-run) DO_DRY_RUN=1 ;;
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf '%b\n' "  ${GREEN}ok${NC}   $*"; }
warn() { printf '%b\n' "  ${YELLOW}warn${NC} $*"; }
fail() { printf '%b\n' "${RED}FAIL${NC}  $*" >&2; exit 1; }
step() { printf '%b\n' "${GREEN}$*${NC}"; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

warn_about_legacy_mirror() {
  if docker exec "$HERMES_CONTAINER" test -f "$LEGACY_MIRROR_PATH" 2>/dev/null; then
    warn "stray third copy present: $LEGACY_MIRROR_PATH — nothing reads it"
    warn "  remove it:  docker exec $HERMES_CONTAINER rm -f $LEGACY_MIRROR_PATH"
  fi
}

# ---------------------------------------------------------------------------
# 1. The repo copy is the contract we expect to publish
# ---------------------------------------------------------------------------
[ -f "$CONTRACT_FILE" ] \
  || fail "no contract at $CONTRACT_FILE
      (pass another one with CONTRACT_FILE=/path/to/contract.md)"
CONTRACT_BYTES="$(wc -c <"$CONTRACT_FILE" | tr -d '[:space:]')"

# Guard against publishing a truncated or pre-v4 file: the whole point of the
# push is that Hermès gets rules 8/9/10 instead of its old PHASE 1 MCP inventory.
for rule in 8 9 10; do
  grep -qE "^# ${rule}\." "$CONTRACT_FILE" \
    || fail "$CONTRACT_FILE has no '# ${rule}.' heading — this is NOT the v4 contract,
      and pushing it would regress Hermès to the MCP-inventory version."
done
grep -q '/opt/data/bridge/directives' "$CONTRACT_FILE" \
  || fail "$CONTRACT_FILE never mentions /opt/data/bridge/directives — rule 8's exchange
      path is the one thing the bridge depends on."
ok "repo copy: $CONTRACT_FILE ($CONTRACT_BYTES bytes, rules 8/9/10 present)"

# ---------------------------------------------------------------------------
# 2. The agent container is up
# ---------------------------------------------------------------------------
docker inspect -f '{{.State.Running}}' "$HERMES_CONTAINER" >/dev/null 2>&1 \
  || fail "container '$HERMES_CONTAINER' does not exist.
      Bring the stack up first:  cd $COMPOSE_DIR && docker compose up -d hermes"
[ "$(docker inspect -f '{{.State.Running}}' "$HERMES_CONTAINER")" = "true" ] \
  || fail "container '$HERMES_CONTAINER' exists but is not running.
      Check it with:  docker compose ps $HERMES_CONTAINER"

# ---------------------------------------------------------------------------
# 3. What is persisted right now
# ---------------------------------------------------------------------------
PERSISTED_STATE=absent
if docker exec "$HERMES_CONTAINER" test -f "$HERMES_CONTRACT_PATH" 2>/dev/null; then
  if docker exec "$HERMES_CONTAINER" cat "$HERMES_CONTRACT_PATH" >"$TMP_DIR/persisted.md" 2>/dev/null; then
    PERSISTED_STATE=present
  else
    PERSISTED_STATE=unreadable
  fi
fi

if [ "$DO_CHECK" -eq 1 ]; then
  case "$PERSISTED_STATE" in
    absent)
      fail "no contract at $HERMES_CONTRACT_PATH inside '$HERMES_CONTAINER'.
      Nothing was changed. Run this script without --check to publish the repo copy." ;;
    unreadable)
      fail "$HERMES_CONTRACT_PATH exists inside '$HERMES_CONTAINER' but could not be read.
      Nothing was changed." ;;
  esac

  if diff -q "$CONTRACT_FILE" "$TMP_DIR/persisted.md" >/dev/null; then
    ok "in sync: the persisted contract is byte-identical to the repo copy"
  else
    warn "OUT OF SYNC — the persisted contract differs from the repo copy"
    warn "(persisted = what Hermès loads; repo = what the stack is written against)"
    diff -u "$TMP_DIR/persisted.md" "$CONTRACT_FILE" | sed -n '3,40p' | sed 's/^/       /'
    warn_about_legacy_mirror
    fail "divergence above. Nothing was changed; run this script without --check to push."
  fi

  warn_about_legacy_mirror
  printf 'Check complete — nothing was changed.\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Publish
# ---------------------------------------------------------------------------
if [ "$DO_DRY_RUN" -eq 1 ]; then
  printf 'would write %s (%s bytes)\n' "$CONTRACT_FILE" "$CONTRACT_BYTES"
  printf '  -> %s:%s  as the container user (ownership preserved)\n' \
    "$HERMES_CONTAINER" "$HERMES_CONTRACT_PATH"
  printf 'then verify rules 8/9/10 landed and print the persistence sentence.\n'
  exit 0
fi

step "Publishing the contract to $HERMES_CONTAINER:$HERMES_CONTRACT_PATH ..."

if docker exec -i "$HERMES_CONTAINER" sh -c 'cat > "$1"' _ "$HERMES_CONTRACT_PATH" \
     <"$CONTRACT_FILE" 2>"$TMP_DIR/write.err"; then
  ok "written as the container's own user (ownership preserved)"
else
  # Fallback for an image without a usable `sh`, or a target the container user
  # cannot truncate. `docker cp` always succeeds as root; re-apply the parent
  # directory's numeric uid:gid afterwards so Hermès keeps write access.
  warn "in-container write refused ($(sed -n '1p' "$TMP_DIR/write.err" | tr -d '\r'))"
  warn "falling back to docker cp (which writes as root, so the owner is reset after)"
  docker cp "$CONTRACT_FILE" "$HERMES_CONTAINER:$HERMES_CONTRACT_PATH" \
    || fail "both write paths failed; nothing was published"

  PARENT_DIR="$(dirname "$HERMES_CONTRACT_PATH")"
  PARENT_OWNER="$(docker exec "$HERMES_CONTAINER" ls -lnd "$PARENT_DIR" 2>/dev/null \
    | awk 'NF >= 9 { print $3":"$4 }' | head -n1)"
  [ -n "$PARENT_OWNER" ] \
    && docker exec "$HERMES_CONTAINER" chown "$PARENT_OWNER" "$HERMES_CONTRACT_PATH" 2>/dev/null
  # A root-owned copy is readable but NOT rewritable, and the contract's own
  # CONSIGNE DE PERSISTANCE has Hermès rewrite this file. Rather than warn about
  # a step that would fail later in the agent conversation, assert it here.
  docker exec "$HERMES_CONTAINER" test -w "$HERMES_CONTRACT_PATH" 2>/dev/null \
    || fail "the file landed but the container's user cannot WRITE it, so Hermès
      cannot run its own persistence step — its rules have it rewrite this file.
        owner now:    $(docker exec "$HERMES_CONTAINER" ls -l "$HERMES_CONTRACT_PATH" 2>/dev/null | awk '{ print $3":"$4 }')
        fix it with:  docker exec $HERMES_CONTAINER chown $PARENT_OWNER $HERMES_CONTRACT_PATH
      (docker cp always writes as root; that is why this path exists at all.)"
  ok "landed through docker cp; owner reset to ${PARENT_OWNER:-the owner of $PARENT_DIR}"
fi

# ---------------------------------------------------------------------------
# 5. Prove what landed, inside the container
# ---------------------------------------------------------------------------
RULES_FOUND="$(docker exec "$HERMES_CONTAINER" grep -cE '^# (8|9|10)\.' "$HERMES_CONTRACT_PATH" 2>/dev/null | tr -d '[:space:]')"
[ "${RULES_FOUND:-0}" -ge 3 ] \
  || fail "the file landed but only ${RULES_FOUND:-0} of rules 8/9/10 are in it — the
      persisted copy is not the v4 contract. Inspect it with:
        docker exec $HERMES_CONTAINER head -20 $HERMES_CONTRACT_PATH"
docker exec "$HERMES_CONTAINER" grep -q '/opt/data/bridge/directives' "$HERMES_CONTRACT_PATH" \
  || fail "rule 8's exchange path (/opt/data/bridge/directives) is missing from the
      persisted copy — Hermès would not know where to drop a directive"
ok "rules 8/9/10 and the bridge exchange path are present"

docker exec "$HERMES_CONTAINER" ls -l "$HERMES_CONTRACT_PATH" | sed 's/^/       /'
warn_about_legacy_mirror

cat <<EOF

$(step 'Next step — the file alone is not the persistence')

  In the Hermès conversation, send:

    Lis $HERMES_CONTRACT_PATH et exécute exactement les instructions de
    persistance qu'il contient.

  Expected ack: {"status":"INTERFACE_CONTRACT_PERSISTED","version":4,...}
  Anything else (or a version < 4): send the block again — it is idempotent.
  Verify the result from here with:
    bash bridge/push-contract.sh --check
EOF
