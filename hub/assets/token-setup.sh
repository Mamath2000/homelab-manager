#!/bin/sh
# Homelab Manager: creates an API token on this Proxmox VE node and sends it to the hub, with the
# single-use code of the command shown in the hub UI (the tokens of a PBS are created by its agent):
#   curl … /token-setup.sh | sh -s -- <code>
# The hub decides the user, token, ACL path and role; the secret is never printed. An existing
# token is kept: its rights are updated and the hub keeps the secret it already holds.
set -eu

HUB_URL="__HUB_URL__"
PIN="__PIN__"
CODE="${1:-}"

fail() { echo "error: $*" >&2; exit 1; }

[ -n "$CODE" ] || fail "usage: sh token-setup.sh <code> (copy the command from the hub UI)"
[ "$(id -u)" -eq 0 ] || fail "must be run as root"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required (apt install jq)"

# the pinned key of the hub agent server: nothing else can answer
hub() { curl -fsSk --pinnedpubkey "sha256//$PIN" -H 'Content-Type: application/json' "$@"; }

PARAMS=$(jq -nc --arg c "$CODE" '{code: $c}' | hub -d @- "$HUB_URL/token-setup/params") \
  || fail "code refused by the hub (expired or already used): generate a new command"
TOOL=$(printf '%s' "$PARAMS" | jq -r .tool)
U=$(printf '%s' "$PARAMS" | jq -r .user)
T=$(printf '%s' "$PARAMS" | jq -r .token)
ACL=$(printf '%s' "$PARAMS" | jq -r .path)
ROLE=$(printf '%s' "$PARAMS" | jq -r .role)
ID="$U!$T"
EXISTING=
OUT=

case "$TOOL" in
  pve)
    command -v pveum >/dev/null 2>&1 || fail "run this on a node of the Proxmox VE cluster (pveum not found)"
    pveum user list --output-format json | jq -e --arg u "$U" 'any(.[]; .userid == $u)' >/dev/null \
      || pveum user add "$U"
    if pveum user token list "$U" --output-format json | jq -e --arg t "$T" 'any(.[]; .tokenid == $t)' >/dev/null; then
      EXISTING=1
    else
      OUT=$(pveum user token add "$U" "$T" --privsep 1)
    fi
    # privilege separation: the user AND the token
    pveum acl modify "$ACL" --roles "$ROLE" --users "$U"
    pveum acl modify "$ACL" --roles "$ROLE" --tokens "$ID"
    ;;
  *) fail "unexpected answer of the hub" ;;
esac

if [ -n "$EXISTING" ]; then
  # rights updated; the hub keeps the secret it holds (refused if it does not know this token)
  jq -nc --arg c "$CODE" --arg i "$ID" '{code: $c, tokenId: $i}' | hub -d @- "$HUB_URL/token-setup/complete" >/dev/null \
    || fail "token $ID already exists and the hub does not hold its secret; delete it and run a new command"
  echo "Token $ID already existed: rights updated, the hub keeps its secret."
  exit 0
fi

# the secret is a UUID, whatever the output format of the command; it only goes to the hub (stdin)
SECRET=$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -n 1)
[ -n "$SECRET" ] || fail "token $ID created but its secret was not found in the output; delete it and run the command again"
jq -nc --arg c "$CODE" --arg i "$ID" --arg s "$SECRET" '{code: $c, tokenId: $i, secret: $s}' | hub -d @- "$HUB_URL/token-setup/complete" >/dev/null \
  || fail "token $ID created but the hub refused it (code expired?); delete it and run a new command"
echo "Token $ID created and sent to Homelab Manager."
