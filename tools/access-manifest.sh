#!/usr/bin/env bash
# Builds and signs the access manifest (issue #312): root SSH keys, sudo user and its keys.
#
#   tools/access-manifest.sh [-c access.json] [-k signing-key] [-o manifest.sig.json] [-p previous.sig.json] [-e days]
#   Defaults: config tools/access.json (gitignored), key ~/.ssh/hlm_signer, output tools/manifest.sig.json (gitignored).
#
# access.json (public keys only, no secret):
#   {
#     "signers": ["ssh-ed25519 AAAA… main", "sk-ssh-ed25519@openssh.com AAAA… backup"],
#     "root":    { "sshKeys": ["ssh-ed25519 AAAA… admin"] },
#     "user":    { "name": "ops", "sudoNoPassword": true, "sshKeys": ["ssh-ed25519 AAAA… admin"] }
#   }
#   - signers: the keys the hosts will trust from now on (the signing key must be one of them; keep a backup key)
#   - user: optional
#
# The manifest is signed with `ssh-keygen -Y sign` (a FIDO key, sk-ssh-ed25519, asks for a touch). The hub never
# sees the private key: upload the output file in Paramètres > Standardisation > Accès. The serial goes up by one
# from the previous bundle (-p, default: the output file when it exists); hosts refuse an older serial.
set -euo pipefail

NS="homelab-manager-access"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HERE}/access.json"
KEY=""
OUT=""
PREV=""
DAYS=""

while getopts "c:k:o:p:e:h" opt; do
  case "$opt" in
    c) CONFIG="$OPTARG" ;;
    k) KEY="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    p) PREV="$OPTARG" ;;
    e) DAYS="$OPTARG" ;;
    *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

# defaults that work without options: the signing key of the admin, the output next to the config
if [ -z "$KEY" ]; then
  for k in "${HOME}/.ssh/hlm_signer" "${HOME}/.ssh/id_ed25519_sk"; do [ -f "$k" ] && KEY="$k" && break; done
fi
[ -n "$OUT" ] || OUT="$(dirname "$CONFIG")/manifest.sig.json"

for bin in jq ssh-keygen base64; do command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }; done
[ -f "$CONFIG" ] || { echo "config not found: $CONFIG" >&2; exit 1; }
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "signing key not found (-k, or ~/.ssh/hlm_signer)" >&2; exit 1; }
[ -n "$PREV" ] || { [ -f "$OUT" ] && PREV="$OUT"; } || true
[ -z "$DAYS" ] || [[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "-e: number of days" >&2; exit 1; }

prev_payload() { jq -c '.payload | @base64d | fromjson' "$PREV" 2>/dev/null || echo '{}'; }
serial=$(( $(prev_payload | jq '.serial // 0') + 1 ))
now=$(date +%s)
expires=0
[ -z "$DAYS" ] || expires=$(( now + DAYS * 86400 ))

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# canonical payload (sorted keys, no whitespace): exactly the bytes that are signed and sent
jq -S -cj --argjson serial "$serial" --argjson now "$now" --argjson exp "$expires" '
  {
    v: 1,
    serial: $serial,
    issuedAt: $now,
    signers: (.signers // error("signers is required")),
    root: { sshKeys: (.root.sshKeys // []) }
  }
  + (if $exp > 0 then { expiresAt: $exp } else {} end)
  + (if .user then { user: { name: .user.name, sudoNoPassword: (.user.sudoNoPassword // false), sshKeys: (.user.sshKeys // []) } } else {} end)
' "$CONFIG" > "$tmp/payload"

# the signing key must be one of the signers, or the hosts would refuse the manifest
awk 'NF >= 2 { print "signer namespaces=\"'"$NS"'\" " $1 " " $2 }' < <(jq -r '.signers[]' "$CONFIG") > "$tmp/allowed_signers"

echo "Serial $serial — signing with $KEY" >&2
ssh-keygen -Y sign -f "$KEY" -n "$NS" "$tmp/payload" >&2
ssh-keygen -Y verify -f "$tmp/allowed_signers" -I signer -n "$NS" -s "$tmp/payload.sig" < "$tmp/payload" >&2 \
  || { echo "the signing key is not in 'signers' of $CONFIG" >&2; exit 1; }

# diff with the previous manifest
summary() { # $1 payload json on stdin
  jq -r '[(.root.sshKeys // [])[] | "root " + (split(" ")[0:2] | join(" "))] + [(.user.sshKeys // [])[] | "user " + (split(" ")[0:2] | join(" "))]
         + (if .user then ["user:" + .user.name + (if .user.sudoNoPassword then " sudo NOPASSWD" else "" end)] else [] end) | .[]'
}
prev_payload | summary | sort > "$tmp/before" || true
jq -c . "$tmp/payload" | summary | sort > "$tmp/after"
echo "--- changes vs previous (serial $((serial - 1)))" >&2
changes=$(diff "$tmp/before" "$tmp/after" | grep '^[<>]' | sed 's/^</removed:/;s/^>/added:  /' || true)
echo "${changes:-(none)}" >&2

jq -n --arg payload "$(base64 -w0 < "$tmp/payload")" --rawfile signature "$tmp/payload.sig" '{ payload: $payload, signature: $signature }' > "$OUT"
echo "Written: $OUT (upload it in Paramètres > Standardisation > Accès)" >&2
