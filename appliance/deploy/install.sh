#!/bin/sh
# Install MaskClaw appliance files from a deploy tree (boot partition or this repo).
set -eu

SRC=${1:-/boot/firmware/maskclaw-deploy}
if [ ! -d "$SRC" ]; then
  SRC=/boot/maskclaw-deploy
fi
if [ ! -d "$SRC" ]; then
  echo "maskclaw-deploy not found at $SRC" >&2
  exit 1
fi
if [ -d "$SRC/src" ] || [ -f "$SRC/Cargo.toml" ] || [ -d "$SRC/crates" ]; then
  echo "refusing to install engine source from $SRC" >&2
  exit 1
fi

# Image clocks are often months behind. apt OpenPGP then fails with "Not live until".
maskclaw_sync_clock() {
  timedatectl set-ntp true 2>/dev/null || true
  n=0
  while [ "$n" -lt 24 ]; do
    if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qx yes; then
      return 0
    fi
    if command -v wget >/dev/null 2>&1; then
      hdr=$(wget -qS -O /dev/null http://deb.debian.org/debian/ 2>&1 | awk 'BEGIN{IGNORECASE=1} /^  Date:/{sub(/^  Date: /,""); print; exit}')
      if [ -n "$hdr" ]; then
        date -u -s "$hdr" >/dev/null 2>&1 && return 0
      fi
    fi
    n=$((n+1))
    sleep 5
  done
  echo "warning: clock may still be unsynced; apt may fail" >&2
}

maskclaw_apt_install() {
  n=0
  while [ "$n" -lt 6 ]; do
    if apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; then
      return 0
    fi
    n=$((n+1))
    echo "apt retry $n" >&2
    sleep 10
  done
  return 1
}

maskclaw_sync_clock
maskclaw_apt_install avahi-daemon caddy python3 ca-certificates network-manager rfkill
systemctl stop caddy.service 2>/dev/null || true
systemctl disable --now caddy.service 2>/dev/null || true
systemctl mask caddy.service 2>/dev/null || true
mkdir -p /var/lib/maskclaw

mkdir -p /opt/maskclaw/bin /opt/maskclaw/www /opt/maskclaw/hostd /etc/maskclaw
if [ -f "$SRC/config/engine.env.example" ]; then
  cp "$SRC/config/engine.env.example" /etc/maskclaw/engine.env.example
fi
cp -a "$SRC/hostd/." /opt/maskclaw/hostd/
if [ -d "$SRC/www" ]; then
  rm -rf /opt/maskclaw/www
  mkdir -p /opt/maskclaw/www
  cp -a "$SRC/www/." /opt/maskclaw/www/
fi
if [ -f "$SRC/bin/switchyard-server" ]; then
  install -m 0755 "$SRC/bin/switchyard-server" /opt/maskclaw/bin/switchyard-server
fi
cp "$SRC/caddy/Caddyfile" /etc/maskclaw/Caddyfile

maskclaw_patch_caddy_tls_hosts() {
	lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
	[ -n "$lan_ip" ] || return 0
	if grep -qF "$lan_ip" /etc/maskclaw/Caddyfile; then
		return 0
	fi
	sed -i "s/^maskclaw.local, localhost, 127.0.0.1 {/maskclaw.local, localhost, 127.0.0.1, ${lan_ip} {/" /etc/maskclaw/Caddyfile
}

maskclaw_patch_caddy_tls_hosts
if [ ! -f /etc/maskclaw/routes.toml ]; then
  cp "$SRC/config/routes.toml.example" /etc/maskclaw/routes.toml
fi
if [ ! -f /etc/maskclaw/maskclaw.toml ]; then
  cp "$SRC/config/maskclaw.toml.example" /etc/maskclaw/maskclaw.toml
fi
cp "$SRC/systemd/"*.service /etc/systemd/system/
cp "$SRC/avahi/maskclaw.service" /etc/avahi/services/maskclaw.service
if [ ! -f /etc/maskclaw/.hostname-user ]; then
  echo maskclaw > /etc/hostname
  hostnamectl set-hostname maskclaw 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable avahi-daemon maskclaw-hostd.service maskclaw-caddy.service
systemctl reset-failed maskclaw-hostd.service maskclaw-caddy.service 2>/dev/null || true
# Restage path: enable --now does not reload an already-running unit, so restart
# after copying binary/www/Caddyfile or HTTPS can stay on the old HTTP-only config.
systemctl restart avahi-daemon maskclaw-hostd.service
if [ -x /opt/maskclaw/bin/switchyard-server ]; then
  systemctl enable maskclaw-server.service
  systemctl reset-failed maskclaw-server.service 2>/dev/null || true
  systemctl restart maskclaw-server.service
fi
systemctl restart maskclaw-caddy.service
# Caddy writes root.crt as mode 600; publish a readable copy for /host/ca.crt downloads.
if [ -f /var/lib/maskclaw/.local/share/caddy/pki/authorities/local/root.crt ]; then
  cp /var/lib/maskclaw/.local/share/caddy/pki/authorities/local/root.crt /etc/maskclaw/caddy-root.crt
  chmod 644 /etc/maskclaw/caddy-root.crt
fi

if ! id admin >/dev/null 2>&1; then
  useradd -m -s /bin/bash admin
  echo 'admin:maskclaw' | chpasswd
fi
for g in adm dialout cdrom sudo audio video plugdev netdev gpio i2c spi; do
  getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" admin || true
done
# First install only: stamp pending password change. Restage must not re-force
# passwd when /etc/maskclaw is preserved and admin already changed it.
if [ ! -f /etc/maskclaw/.factory-ssh-seeded ]; then
  touch /etc/maskclaw/.factory-ssh-pending
  touch /etc/maskclaw/.factory-ssh-seeded
fi
if [ ! -f /etc/maskclaw/dashboard.auth ] && [ ! -f /etc/maskclaw/setup.token ]; then
  umask 077
  python3 -c 'import secrets, pathlib; pathlib.Path("/etc/maskclaw/setup.token").write_text(secrets.token_urlsafe(32) + "\n")'
  chmod 600 /etc/maskclaw/setup.token
fi
if [ -f /etc/maskclaw/setup.token ]; then
  SETUP_TOKEN=$(tr -d '\n' < /etc/maskclaw/setup.token)
  cat > /etc/motd <<EOF
MaskClaw appliance
Factory login: SSH will force a password change on first login.
Dashboard setup token: ${SETUP_TOKEN}
Enter this token at https://<pi-ip>/ when setting the dashboard password.
After SSH login you can change your password anytime with:  passwd
EOF
else
  cat > /etc/motd <<'EOF'
MaskClaw appliance
Factory login: SSH will force a password change on first login.
After that you can change it anytime with:  passwd
EOF
fi
cat > /etc/profile.d/maskclaw-force-passwd.sh <<'EOF'
# MaskClaw factory SSH: require password change on first interactive admin login.
if [ -n "${PS1-}" ] && [ "$(id -un)" = "admin" ] && [ -f /etc/maskclaw/.factory-ssh-pending ]; then
  echo "MaskClaw factory login: you must change the default password before continuing."
  until passwd; do
    echo "Password change is required. Try again with: passwd"
  done
  rm -f /etc/maskclaw/.factory-ssh-pending
fi
EOF
cat > /etc/profile.d/maskclaw-passwd-hint.sh <<'EOF'
if [ -n "${PS1-}" ] && [ "$(id -un)" != "root" ]; then
  echo "Change your password anytime with:  passwd"
fi
EOF
