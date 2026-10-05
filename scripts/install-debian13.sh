#!/bin/bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then echo 'Bitte mit sudo ausführen.' >&2; exit 1; fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd "${script_dir}/.." && pwd)
if [ ! -f "${project_dir}/dist/api.js" ] || [ ! -f "${project_dir}/web/dist/index.html" ]; then
  echo 'Build fehlt. Zuerst npm ci && npm run build ausführen.' >&2; exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y xorg xinit openbox chromium nodejs avahi-daemon x11-xserver-utils xdotool dbus-user-session openssl
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "${node_major}" -lt 20 ]; then echo 'Node.js 20 oder neuer benötigt.' >&2; exit 1; fi

getent group screenable >/dev/null || groupadd --system screenable
id screenable-api >/dev/null 2>&1 || useradd --system --gid screenable --home-dir /var/lib/screenable-player --shell /usr/sbin/nologin screenable-api
id screenable >/dev/null 2>&1 || useradd --system --gid screenable --create-home --home-dir /home/screenable --shell /bin/bash screenable

install -d -o root -g root -m 0755 /opt/screenable-player /opt/screenable-player/dist /opt/screenable-player/web /opt/screenable-player/web/dist /opt/screenable-player/scripts
install -o root -g root -m 0644 "${project_dir}/package.json" /opt/screenable-player/package.json
cp -r "${project_dir}/dist/." /opt/screenable-player/dist/
cp -r "${project_dir}/web/dist/." /opt/screenable-player/web/dist/
install -o root -g root -m 0755 "${project_dir}/scripts/xsession" /opt/screenable-player/scripts/xsession
install -o root -g root -m 0644 "${project_dir}/scripts/diagnostic-server.mjs" /opt/screenable-player/scripts/diagnostic-server.mjs
chown -R root:root /opt/screenable-player
install -d -o screenable-api -g screenable -m 0750 /var/lib/screenable-player
install -d -o screenable -g screenable -m 0700 /var/lib/screenable-player/profiles
install -d -o root -g root -m 0755 /etc/screenable-player

if [ ! -f /var/lib/screenable-player/secrets.json ]; then
  echo 'Administratorpasswort für das Dashboard festlegen:'
  runuser -u screenable-api -- /usr/bin/node /opt/screenable-player/dist/cli.js init
fi
if [ ! -f /etc/screenable-player/tls.key ]; then
  device_name=$(hostname -s)
  openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
    -keyout /etc/screenable-player/tls.key -out /etc/screenable-player/tls.crt \
    -subj "/CN=${device_name}.local" -addext "subjectAltName=DNS:${device_name}.local"
  chown screenable-api:screenable /etc/screenable-player/tls.key
  chmod 0600 /etc/screenable-player/tls.key
fi

install -o root -g root -m 0644 "${project_dir}/systemd/screenable-api.service" /etc/systemd/system/screenable-api.service
install -o root -g root -m 0644 "${project_dir}/systemd/screenable-player.service" /etc/systemd/user/screenable-player.service
install -o root -g root -m 0644 "${project_dir}/avahi/screenable-player.service" /etc/avahi/services/screenable-player.service
install -d -o root -g root -m 0755 /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/screenable-autologin.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin screenable --noclear %I $TERM
EOF
cat > /home/screenable/.profile <<'EOF'
if [ "$(tty)" = /dev/tty1 ] && [ -z "${DISPLAY:-}" ]; then
  exec startx /opt/screenable-player/scripts/xsession -- :0 vt1 -nolisten tcp
fi
EOF
chown screenable:screenable /home/screenable/.profile
chmod 0644 /home/screenable/.profile

systemctl daemon-reload
systemctl enable --now avahi-daemon.service screenable-api.service getty@tty1.service
echo "Installiert. Dashboard: https://$(hostname -s).local:8443"
echo 'Selbstsigniertes Zertifikat auf dem Verwaltungsgerät vertrauen. Für den Kiosk ist ein Neustart empfohlen.'
