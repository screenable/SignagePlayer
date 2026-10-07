#!/bin/bash
# Aktiviert das Release, in dem dieses Skript liegt: Systemdateien aus dem Release
# installieren, /opt/screenable-player/current atomar umstellen, Dienste neu starten
# und den API-Health-Check abwarten. Wird von install.sh und rollback.sh genutzt.
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then echo 'Bitte mit sudo ausführen.' >&2; exit 1; fi
release=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
base=/opt/screenable-player
case "${release}" in "${base}/releases/"*) ;; *) echo "Kein installiertes Release: ${release}" >&2; exit 1 ;; esac

# Geräteoptionen aus dem Installer, damit ein Rollback dieselben Einstellungen nutzt.
SCREENABLE_KIOSK_LOCKDOWN=1
# shellcheck disable=SC1091
if [ -f /etc/screenable-player/install.env ]; then . /etc/screenable-player/install.env; fi

put() { install -D -o root -g root -m 0644 "${release}/$1" "$2"; }
put systemd/screenable-api.service /etc/systemd/system/screenable-api.service
put systemd/screenable-player.service /etc/systemd/user/screenable-player.service
put system/tmpfiles.conf /etc/tmpfiles.d/screenable-player.conf
put system/journald.conf /etc/systemd/journald.conf.d/screenable-player.conf
put avahi/screenable-player.service /etc/avahi/services/screenable-player.service
put chromium/screenable-kiosk.json /etc/chromium/policies/managed/screenable-kiosk.json
put xorg/10-screenable-kiosk.conf /etc/X11/xorg.conf.d/10-screenable-kiosk.conf
if [ "${SCREENABLE_KIOSK_LOCKDOWN}" = 1 ]; then
  put xorg/20-screenable-lockdown.conf /etc/X11/xorg.conf.d/20-screenable-lockdown.conf
  put system/sysctl-lockdown.conf /etc/sysctl.d/90-screenable-lockdown.conf
  sysctl -q --load=/etc/sysctl.d/90-screenable-lockdown.conf || true
else
  rm -f /etc/X11/xorg.conf.d/20-screenable-lockdown.conf /etc/sysctl.d/90-screenable-lockdown.conf
fi

install -d -o root -g root -m 0755 /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/screenable-autologin.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin screenable --noclear %I $TERM
EOF
cat > /home/screenable/.profile <<'EOF'
if [ "$(tty)" = /dev/tty1 ] && [ -z "${DISPLAY:-}" ]; then
  exec startx /opt/screenable-player/current/scripts/xsession -- :0 vt1 -nolisten tcp
fi
EOF
chown screenable:screenable /home/screenable/.profile
chmod 0644 /home/screenable/.profile

ln -sfn "${release}" "${base}/current.new"
mv -T "${base}/current.new" "${base}/current"

systemctl daemon-reload
systemd-tmpfiles --create /etc/tmpfiles.d/screenable-player.conf
systemctl restart systemd-journald.service
systemctl enable avahi-daemon.service screenable-api.service getty@tty1.service >/dev/null
systemctl start avahi-daemon.service getty@tty1.service
systemctl restart screenable-api.service
# Läuft die Kiosk-Sitzung bereits, den Player sofort auf das neue Release umstellen.
if systemctl --user -M screenable@ daemon-reload 2>/dev/null; then
  systemctl --user -M screenable@ try-restart screenable-player.service 2>/dev/null || true
fi

for _ in $(seq 1 20); do
  if /usr/bin/node -e "require('https').get({host:'127.0.0.1',port:8443,path:'/api/v1/health',rejectUnauthorized:false,timeout:2000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then
    echo "Aktiv: $(basename "${release}")"
    exit 0
  fi
  sleep 1
done
echo "Health-Check fehlgeschlagen: $(basename "${release}"). Logs: journalctl -u screenable-api -n 50" >&2
exit 1
