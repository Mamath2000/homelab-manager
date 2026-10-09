#!/bin/sh
# Homelab Manager agent installer.
#   install / upgrade : curl -fsSL __HUB_URL__/install.sh | sh -s -- <token>
#   upgrade (keep token): curl -fsSL __HUB_URL__/install.sh | sh
#   uninstall         : curl -fsSL __HUB_URL__/install.sh | sh -s -- --uninstall
set -eu

HUB_URL="__HUB_URL__"
BIN=/usr/local/bin/homelab-agent
ENV_FILE=/etc/homelab-agent.env
UNIT=/etc/systemd/system/homelab-agent.service

fail() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must be run as root"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now homelab-agent >/dev/null 2>&1 || true
  rm -f "$BIN" "$ENV_FILE" "$UNIT"
  systemctl daemon-reload
  echo "homelab-agent removed"
  exit 0
fi

TOKEN="${1:-}"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  TOKEN=$(sed -n 's/^AGENT_TOKEN=//p' "$ENV_FILE")
fi
[ -n "$TOKEN" ] || fail "usage: install.sh <token> | --uninstall"
case "$TOKEN" in
  *[!A-Za-z0-9._-]*) fail "invalid token" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$HUB_URL/agent/download/$ARCH" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$HUB_URL/agent/download/$ARCH"
else
  fail "curl or wget is required"
fi
install -m 0755 "$TMP" "$BIN"

(umask 077 && printf 'HUB_URL=%s\nAGENT_TOKEN=%s\n' "$HUB_URL" "$TOKEN" > "$ENV_FILE")

cat > "$UNIT" <<UNIT
[Unit]
Description=Homelab Manager agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
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
echo "homelab-agent $("$BIN" -version) installed and running, reporting to $HUB_URL"
