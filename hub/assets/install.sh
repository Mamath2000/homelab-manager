#!/bin/sh
# Homelab Manager agent installer, served on the TLS agent port of the hub. The commands shown in the
# hub UI pin the hub key (curl --pinnedpubkey), so this script and the binary come from the hub.
#   install   : curl -fsSLk --pinnedpubkey sha256//__PIN__ __HUB_URL__/install.sh | sh -s -- <code> [--dir DIR]
#   upgrade   : curl -fsSLk --pinnedpubkey sha256//__PIN__ __HUB_URL__/install.sh | sh
#   uninstall : curl -fsSLk --pinnedpubkey sha256//__PIN__ __HUB_URL__/install.sh | sh -s -- --uninstall
#
# Layout
#   systemd hosts (Debian, Ubuntu...): /usr/local/bin/homelab-agent, /etc/homelab-agent/ (identity,
#     agent.env), /var/lib/homelab-agent/ (state); with --dir DIR, everything goes into DIR.
#   Unraid: the system lives in RAM, so the files are kept in DIR (default on the flash drive,
#     /boot/config/plugins/homelab-agent) and the agent is started at boot by /boot/config/go,
#     from a copy in /usr/local/bin.
#   WSL: as systemd hosts, once systemd is enabled in /etc/wsl.conf (the installer enables it and
#     asks for a `wsl --shutdown` first).
set -eu

HUB_URL="__HUB_URL__"
PIN="__PIN__"
UNIT=/etc/systemd/system/homelab-agent.service
LEGACY_ENV=/etc/homelab-agent.env
GO_FILE=/boot/config/go
GO_MARK="# homelab-agent"
UNRAID_DIR=/boot/config/plugins/homelab-agent
WSL_CONF=/etc/wsl.conf

fail() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must be run as root"
# wget cannot pin a key: curl is the only way to know the files come from the hub
command -v curl >/dev/null 2>&1 || fail "curl is required"

UNRAID=
[ -f /etc/unraid-version ] && UNRAID=1
WSL=
grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && WSL=1

# sets systemd=true in the [boot] section of a wsl.conf, leaving the rest of the file as is
enable_wsl_systemd() {
  tmp=$(mktemp)
  [ -f "$1" ] || : > "$1"
  awk '
    /^[[:space:]]*\[/ {
      boot = ($0 ~ /^[[:space:]]*\[boot\][[:space:]]*$/)
      print
      if (boot && !done) { print "systemd=true"; done = 1 }
      next
    }
    boot && /^[[:space:]]*systemd[[:space:]]*=/ { next }
    { print }
    END { if (!done) { if (NR) print ""; print "[boot]"; print "systemd=true" } }
  ' "$1" > "$tmp"
  cat "$tmp" > "$1"
  rm -f "$tmp"
}

CODE=
NEWDIR=
UNINSTALL=
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --dir) [ $# -ge 2 ] || fail "--dir needs a directory"; NEWDIR="$2"; shift ;;
    --dir=*) NEWDIR="${1#--dir=}" ;;
    # anything else is the code (base64url: it may start with a dash)
    *) CODE="$1" ;;
  esac
  shift
done
case "$CODE" in
  *[!A-Za-z0-9_-]*) fail "invalid enrollment code" ;;
esac
if [ -n "$NEWDIR" ]; then
  NEWDIR="${NEWDIR%/}"
  case "$NEWDIR" in
    /*) ;;
    *) fail "--dir must be an absolute path" ;;
  esac
  case "$NEWDIR" in
    "" | *[!A-Za-z0-9._/-]*) fail "--dir: only letters, digits and . _ - / are allowed" ;;
  esac
fi

# systemctl may exist without systemd running (WSL without systemd)
if [ -z "$UNRAID" ] && [ ! -d /run/systemd/system ]; then
  if [ -n "$WSL" ] && [ -z "$UNINSTALL" ]; then
    [ -x /lib/systemd/systemd ] || fail "WSL: systemd is not installed: apt install systemd systemd-sysv, then run this command again"
    enable_wsl_systemd "$WSL_CONF"
    fail "WSL: systemd is now enabled in $WSL_CONF; run 'wsl --shutdown' from Windows, reopen the distribution, then run this command again"
  fi
  fail "systemd is required (or Unraid)"
fi

# --- current installation, found from the service (systemd) or the boot script (Unraid)
OLDDIR=
OLDBIN=
if [ -n "$UNRAID" ]; then
  if [ -f "$GO_FILE" ]; then
    OLDDIR=$(sed -n "s|^sh \(.*\)/start.sh &.*$GO_MARK\$|\1|p" "$GO_FILE" | head -n 1)
  fi
  OLDBIN=/usr/local/bin/homelab-agent
elif [ -f "$UNIT" ]; then
  OLDDIR=$(sed -n 's|^EnvironmentFile=\(.*\)/agent.env$|\1|p' "$UNIT" | head -n 1)
  OLDBIN=$(sed -n 's|^ExecStart=||p' "$UNIT" | head -n 1)
fi

stop_unraid() {
  if [ -f /var/run/homelab-agent.pid ]; then
    kill "$(cat /var/run/homelab-agent.pid)" 2>/dev/null || true
    rm -f /var/run/homelab-agent.pid
  fi
  # the supervisor loop is gone: stop the agent itself
  for pid in $(pidof homelab-agent 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
}

# removes what the installer put in a directory, and the directory if nothing else is left
clean_dir() {
  [ -n "$1" ] && [ -d "$1" ] || return 0
  rm -f "$1/homelab-agent" "$1/agent.env" "$1/ca.pem" "$1/agent.key" "$1/agent.crt" "$1/stacks.json" "$1/start.sh"
  rm -rf "$1/state"
  rmdir "$1" 2>/dev/null || true
}

if [ -n "$UNINSTALL" ]; then
  if [ -n "$UNRAID" ]; then
    stop_unraid
    [ -f "$GO_FILE" ] && sed -i "/$GO_MARK\$/d" "$GO_FILE"
    rm -f /usr/local/bin/homelab-agent
    clean_dir "${OLDDIR:-$UNRAID_DIR}"
  else
    systemctl disable --now homelab-agent >/dev/null 2>&1 || true
    rm -f "${OLDBIN:-/usr/local/bin/homelab-agent}" /usr/local/bin/homelab-agent "$UNIT" "$LEGACY_ENV"
    clean_dir "${OLDDIR:-/etc/homelab-agent}"
    rm -rf /var/lib/homelab-agent
    systemctl daemon-reload
  fi
  echo "homelab-agent removed"
  exit 0
fi

# --- target layout
if [ -n "$UNRAID" ]; then
  DIR="${NEWDIR:-${OLDDIR:-$UNRAID_DIR}}"
  BIN=/usr/local/bin/homelab-agent # RAM copy, restored from $DIR at boot
  STATE="$DIR"
elif [ -n "$NEWDIR" ]; then
  DIR="$NEWDIR"
  BIN="$DIR/homelab-agent"
  STATE="$DIR/state"
elif [ -n "$OLDDIR" ] && [ "$OLDDIR" != /etc/homelab-agent ]; then
  DIR="$OLDDIR"
  BIN="$DIR/homelab-agent"
  STATE="$DIR/state"
else
  DIR=/etc/homelab-agent
  BIN=/usr/local/bin/homelab-agent
  STATE=/var/lib/homelab-agent
fi

# moving an installation without a new code: bring its identity along
if [ -z "$CODE" ] && [ ! -f "$DIR/agent.crt" ] && [ -n "$OLDDIR" ] && [ -f "$OLDDIR/agent.crt" ]; then
  install -d -m 0700 "$DIR"
  cp "$OLDDIR/agent.key" "$OLDDIR/agent.crt" "$DIR/"
fi
if [ -z "$CODE" ] && [ ! -f "$DIR/agent.crt" ]; then
  if [ -f "$LEGACY_ENV" ]; then
    fail "this agent still uses the old plain-text token: reinstall it with a new install command from the hub UI (Hôtes > hôte > Nouvelle commande d'installation)"
  fi
  fail "usage: install.sh <enrollment code> [--dir DIR] | --uninstall (the code is in the install command shown by the hub)"
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSLk --pinnedpubkey "sha256//$PIN" "$HUB_URL/agent/download/$ARCH" -o "$TMP"
install -d -m 0700 "$DIR"
install -m 0755 "$TMP" "$BIN"
# Unraid: the copy kept on the flash drive, restored at boot
[ -n "$UNRAID" ] && cp "$TMP" "$DIR/homelab-agent"

# hub CA, pinned by the agent for every connection
cat > "$DIR/ca.pem" <<'CA'
__CA_PEM__
CA

if [ -n "$CODE" ]; then
  # the key is generated on this host; only a certificate request is sent
  "$BIN" enroll -hub "$HUB_URL" -dir "$DIR" -code "$CODE"
fi

(
  umask 077
  printf 'HUB_URL=%s\nAGENT_DIR=%s\nAGENT_STATE_DIR=%s\n' "$HUB_URL" "$DIR" "$STATE" > "$DIR/agent.env"
  # Unraid: self-updates also refresh the copy kept on the flash drive
  [ -n "$UNRAID" ] && printf 'AGENT_PERSIST_BIN=%s\n' "$DIR/homelab-agent" >> "$DIR/agent.env"
  true
)
rm -f "$LEGACY_ENV"

# an installation moved elsewhere: remove the previous one
if [ -n "$OLDDIR" ] && [ "$OLDDIR" != "$DIR" ]; then
  clean_dir "$OLDDIR"
  [ "$OLDDIR" = /etc/homelab-agent ] && rm -rf /var/lib/homelab-agent
fi
if [ -n "$OLDBIN" ] && [ "$OLDBIN" != "$BIN" ]; then
  rm -f "$OLDBIN"
fi

if [ -n "$UNRAID" ]; then
  cat > "$DIR/start.sh" <<START
#!/bin/sh
# Starts the Homelab Manager agent at boot (line in /boot/config/go). Restarts it when it exits,
# after a self-update for instance.
install -m 0755 "$DIR/homelab-agent" /usr/local/bin/homelab-agent
nohup sh -c 'set -a; . "$DIR/agent.env"; set +a; while :; do /usr/local/bin/homelab-agent; sleep 5; done' >> /var/log/homelab-agent.log 2>&1 &
echo \$! > /var/run/homelab-agent.pid
START
  [ -f "$GO_FILE" ] || printf '#!/bin/bash\n' > "$GO_FILE"
  sed -i "/$GO_MARK\$/d" "$GO_FILE"
  echo "sh $DIR/start.sh & $GO_MARK" >> "$GO_FILE"
  stop_unraid
  sh "$DIR/start.sh"
else
  install -d -m 0700 "$STATE"
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
fi
echo "homelab-agent $("$BIN" -version) installed in $DIR and running, reporting to $HUB_URL (TLS)"
