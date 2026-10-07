#!/bin/bash
# Installiert oder aktualisiert den Screenable Player auf Debian 13.
#
# Optionen über Umgebungsvariablen (Werte bleiben in /etc/screenable-player/install.env):
#   SCREENABLE_KIOSK_LOCKDOWN=1|0       Konsolenwechsel und Magic-SysRq sperren (Standard 1)
#   SCREENABLE_UNATTENDED_UPGRADES=1|0  Debian-Sicherheitsupdates automatisch einspielen (Standard 1)
#   SCREENABLE_REBOOT_TIME=04:00        Uhrzeit für nötige Neustarts nach Updates
#   SCREENABLE_KEEP_RELEASES=3          Anzahl aufbewahrter Releases für Rollbacks
#   SCREENABLE_FIREWALL=1|0             Eingehende Verbindungen nur aus dem Hotspot (Standard 1)
#   SCREENABLE_HOTSPOT_CONNECTION=…     NetworkManager-Profil des Hotspots (Standard Giada-Hotspot)
#   SCREENABLE_ADMIN_INTERFACES=…       Schnittstellen mit Verwaltungszugang (Standard: Gerät des Hotspots)
#   SCREENABLE_HOTSPOT_ADDRESS=10.42.0.1  feste Adresse des Geräts im Hotspot
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then echo 'Bitte mit sudo ausführen.' >&2; exit 1; fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd "${script_dir}/.." && pwd)
if [ ! -f "${project_dir}/dist/api.js" ] || [ ! -f "${project_dir}/web/dist/index.html" ]; then
  echo 'Build fehlt. Zuerst npm ci && npm run build ausführen.' >&2; exit 1
fi

# Gespeicherte Optionen übernehmen; beim Aufruf gesetzte Variablen haben Vorrang.
if [ -f /etc/screenable-player/install.env ]; then
  while IFS='=' read -r key value; do
    [[ "${key}" =~ ^SCREENABLE_[A-Z_]+$ ]] || continue
    [ -n "${!key+x}" ] || printf -v "${key}" '%s' "${value//\"/}"
  done < /etc/screenable-player/install.env
fi
lockdown=${SCREENABLE_KIOSK_LOCKDOWN:-1}
unattended=${SCREENABLE_UNATTENDED_UPGRADES:-1}
reboot_time=${SCREENABLE_REBOOT_TIME:-04:00}
keep=${SCREENABLE_KEEP_RELEASES:-3}
firewall=${SCREENABLE_FIREWALL:-1}
hotspot_connection=${SCREENABLE_HOTSPOT_CONNECTION:-Giada-Hotspot}
hotspot_address=${SCREENABLE_HOTSPOT_ADDRESS:-10.42.0.1}
admin_interfaces=${SCREENABLE_ADMIN_INTERFACES:-}
if [ -z "${admin_interfaces}" ] && command -v nmcli >/dev/null 2>&1; then
  # Schnittstelle des aktiven Hotspots übernehmen (auf dem D613 wlp2s0).
  admin_interfaces=$(nmcli -g GENERAL.DEVICES connection show "${hotspot_connection}" 2>/dev/null || true)
fi
admin_interfaces=${admin_interfaces:-wlp2s0}
[[ "${lockdown}" =~ ^[01]$ && "${unattended}" =~ ^[01]$ && "${firewall}" =~ ^[01]$ ]] || { echo 'Optionen müssen 0 oder 1 sein.' >&2; exit 1; }
[[ "${reboot_time}" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo 'SCREENABLE_REBOOT_TIME im Format HH:MM angeben.' >&2; exit 1; }
if ! [[ "${keep}" =~ ^[0-9]+$ ]] || [ "${keep}" -lt 2 ]; then echo 'SCREENABLE_KEEP_RELEASES muss mindestens 2 sein.' >&2; exit 1; fi

if systemctl is-enabled --quiet display-manager.service 2>/dev/null; then
  echo 'Warnung: Ein Display-Manager ist aktiv und konkurriert mit der Kiosk-Sitzung auf tty1.' >&2
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  xorg xinit openbox chromium nodejs avahi-daemon x11-xserver-utils xdotool dbus-user-session openssl nftables
# Optional: blendet den Mauszeiger im Leerlauf aus.
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unclutter-xfixes \
  || echo 'Hinweis: unclutter-xfixes nicht installiert; Mauszeiger bleibt sichtbar.' >&2
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "${node_major}" -lt 20 ]; then echo 'Node.js 20 oder neuer benötigt.' >&2; exit 1; fi

getent group screenable >/dev/null || groupadd --system screenable
id screenable-api >/dev/null 2>&1 || useradd --system --gid screenable --home-dir /var/lib/screenable-player --shell /usr/sbin/nologin screenable-api
id screenable >/dev/null 2>&1 || useradd --system --gid screenable --create-home --home-dir /home/screenable --shell /bin/bash screenable

install -d -o root -g root -m 0755 /etc/screenable-player
cat > /etc/screenable-player/install.env <<EOF
SCREENABLE_KIOSK_LOCKDOWN=${lockdown}
SCREENABLE_UNATTENDED_UPGRADES=${unattended}
SCREENABLE_REBOOT_TIME=${reboot_time}
SCREENABLE_KEEP_RELEASES=${keep}
SCREENABLE_FIREWALL=${firewall}
SCREENABLE_HOTSPOT_CONNECTION="${hotspot_connection}"
SCREENABLE_ADMIN_INTERFACES="${admin_interfaces}"
SCREENABLE_HOTSPOT_ADDRESS=${hotspot_address}
EOF

# Release anlegen. Der Name beginnt mit dem UTC-Zeitstempel, damit die Sortierung
# der Installationsreihenfolge entspricht.
base=/opt/screenable-player
version=$(node -p "require('${project_dir}/package.json').version")
commit=$(git -C "${project_dir}" rev-parse --short HEAD 2>/dev/null || echo unbekannt)
name="$(date -u +%Y%m%dT%H%M%SZ)-${version}"
release="${base}/releases/${name}"
previous=$(readlink -e "${base}/current" 2>/dev/null || true)
install -d -o root -g root -m 0755 "${base}" "${base}/releases" "${release}"
for item in package.json README.md docs dist web/dist openbox systemd system avahi chromium xorg; do
  install -d -m 0755 "$(dirname "${release}/${item}")"
  cp -a "${project_dir}/${item}" "${release}/${item}"
done
rm -rf "${release}/dist/tests"
install -d -m 0755 "${release}/scripts"
for script in xsession activate-release.sh rollback.sh renew-tls.sh configure-access.sh; do
  install -m 0755 "${project_dir}/scripts/${script}" "${release}/scripts/${script}"
done
install -m 0644 "${project_dir}/scripts/diagnostic-server.mjs" "${release}/scripts/diagnostic-server.mjs"
printf 'version=%s\ncommit=%s\ninstalled=%s\n' "${version}" "${commit}" "$(date -u +%FT%TZ)" > "${release}/RELEASE"
chown -R root:root "${release}"
chmod -R go-w "${release}"

install -d -o screenable-api -g screenable -m 0750 /var/lib/screenable-player
install -d -o screenable -g screenable -m 0700 /var/lib/screenable-player/profiles
if [ ! -f /var/lib/screenable-player/secrets.json ]; then
  echo 'Administratorpasswort für das Dashboard festlegen:'
  runuser -u screenable-api -- /usr/bin/node "${release}/dist/cli.js" init
fi
"${release}/scripts/renew-tls.sh" --if-missing
if ! openssl x509 -in /etc/screenable-player/tls.crt -noout -checkip "${hotspot_address}" | grep -q 'does match'; then
  echo "Hinweis: Das Zertifikat enthält ${hotspot_address} nicht. Für Zugriff per IP: sudo ${base}/current/scripts/renew-tls.sh" >&2
fi

if [ "${unattended}" = 1 ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  cat > /etc/apt/apt.conf.d/52screenable-unattended-upgrades <<EOF
// Verwaltet von scripts/install-debian13.sh (SCREENABLE_REBOOT_TIME).
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "${reboot_time}";
EOF
else
  rm -f /etc/apt/apt.conf.d/52screenable-unattended-upgrades
fi

"${release}/scripts/configure-access.sh"

if ! "${release}/scripts/activate-release.sh"; then
  if [ -n "${previous}" ] && [ -x "${previous}/scripts/activate-release.sh" ]; then
    echo "Rollback auf $(basename "${previous}")." >&2
    # Das fehlerhafte Release entfernen, damit es kein späteres Rollback-Ziel wird.
    if "${previous}/scripts/activate-release.sh"; then rm -rf "${release}"; fi
  fi
  exit 1
fi

# Programmdateien der Version 0.1 lagen direkt unter /opt/screenable-player.
rm -rf "${base}/dist" "${base}/web" "${base}/scripts" "${base}/package.json"
# Alte Releases aufräumen; das aktive und das vorherige bleiben immer erhalten.
mapfile -t releases < <(find "${base}/releases" -mindepth 1 -maxdepth 1 -type d | sort)
for ((i = 0; i < ${#releases[@]} - keep; i++)); do
  r=${releases[$i]}
  if [ "${r}" != "${release}" ] && [ "${r}" != "${previous}" ]; then rm -rf "${r}"; fi
done

echo "Installiert: ${name}. Dashboard im Hotspot: https://${hotspot_address}:8443 oder https://$(hostname -s).local:8443"
echo 'Selbstsigniertes Zertifikat auf dem Verwaltungsgerät vertrauen. Nach der Erstinstallation das Gerät neu starten.'
