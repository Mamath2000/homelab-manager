#!/bin/sh
# Homelab Manager agent installer, served on the TLS agent port of the hub. The commands shown in the
# hub UI pin the hub key (curl --pinnedpubkey), so this script and the binary come from the hub.
#   install   : curl -fsSLk --pinnedpubkey sha256//__PIN__ __HUB_URL__/install.sh | sh -s -- <code>
#   upgrade   : curl -fsSLk --pinnedpubkey sha256//__PIN__ __HUB_URL__/install.sh | sh
#   uninstall : curl -fsSLk --pinnedpubkey sha256//__PIN__ __HUB_URL__/install.sh | sh -s -- --uninstall
set -eu

HUB_URL="__HUB_URL__"
PIN="__PIN__"
BIN=/usr/local/bin/homelab-agent
DIR=/etc/homelab-agent
UNIT=/etc/systemd/system/homelab-agent.service
LEGACY_ENV=/etc/homelab-agent.env

fail() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must be run as root"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
# wget cannot pin a key: curl is the only way to know the files come from the hub
command -v curl >/dev/null 2>&1 || fail "curl is required (apt install curl)"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now homelab-agent >/dev/null 2>&1 || true
  rm -f "$BIN" "$UNIT" "$LEGACY_ENV"
  rm -rf "$DIR"
  systemctl daemon-reload
  echo "homelab-agent removed"
  exit 0
fi

CODE="${1:-}"
case "$CODE" in
  *[!A-Za-z0-9_-]*) fail "invalid enrollment code" ;;
esac
if [ -z "$CODE" ] && [ ! -f "$DIR/agent.crt" ]; then
  if [ -f "$LEGACY_ENV" ]; then
    fail "this agent still uses the old plain-text token: reinstall it with a new install command from the hub UI (Hôtes > hôte > Nouvelle commande d'installation)"
  fi
  fail "usage: install.sh <enrollment code> | --uninstall (the code is in the install command shown by the hub)"
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSLk --pinnedpubkey "sha256//$PIN" "$HUB_URL/agent/download/$ARCH" -o "$TMP"
install -m 0755 "$TMP" "$BIN"

# hub CA, pinned by the agent for every connection
install -d -m 0700 "$DIR"
cat > "$DIR/ca.pem" <<'CA'
__CA_PEM__
CA

if [ -n "$CODE" ]; then
  # the key is generated on this host; only a certificate request is sent
  "$BIN" enroll -hub "$HUB_URL" -dir "$DIR" -code "$CODE"
fi

(umask 077 && printf 'HUB_URL=%s\nAGENT_DIR=%s\n' "$HUB_URL" "$DIR" > "$DIR/agent.env")
rm -f "$LEGACY_ENV"

cat > "$UNIT" <<UNIT
[Unit]
Description=Homelab Manager agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$DIR/agent.env
ExecStart=$BIN
Restart=always
RestartSec=5
# restarting the agent must not kill an apt/dpkg run it started
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable homelab-agent >/dev/null 2>&1
systemctl restart homelab-agent
echo "homelab-agent $("$BIN" -version) installed and running, reporting to $HUB_URL (TLS)"
