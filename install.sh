#!/bin/bash
# Screenable Player: Installation und Aktualisierung auf Debian 13 in einem Durchgang.
#
# Direkt von GitHub (lädt das neueste Release, prüft die Prüfsumme und installiert):
#   curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo bash
#
# Aus einem entpackten Installationspaket oder Git-Checkout:
#   sudo ./install.sh            interaktiv: fragt Passwörter ab, die noch fehlen
#   sudo ./install.sh --help     alle Optionen
#
# Jeder Schritt prüft zuerst, ob er bereits erledigt ist. Bricht die Installation ab,
# die Ursache beheben und das Skript erneut starten; Erledigtes wird übersprungen.
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Aufruf: sudo ./install.sh
   oder: curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo bash

Download von GitHub (nur beim Aufruf per curl):
  SCREENABLE_VERSION=v0.3.0                     bestimmtes Release statt des neuesten
  SCREENABLE_GITHUB_TOKEN=…                     Lese-Token, solange das Repository privat ist

Optionen als Umgebungsvariablen (werden in /etc/screenable-player/install.env gespeichert;
beim Aufruf gesetzte Werte haben Vorrang):
  SCREENABLE_HOTSPOT_CONNECTION=Giada-Hotspot   NetworkManager-Profil des Hotspots
  SCREENABLE_HOTSPOT_SSID=Giada-WIFI            WLAN-Name, nur beim Anlegen des Profils
  SCREENABLE_HOTSPOT_ADDRESS=10.42.0.1          feste Adresse des Geräts im Hotspot
  SCREENABLE_ADMIN_INTERFACES=…                 Schnittstellen mit Verwaltungszugang (Standard: WLAN des Hotspots)
  SCREENABLE_FIREWALL=1|0                       eingehende Verbindungen nur aus dem Hotspot
  SCREENABLE_LTE=auto|1|0                       LTE-Profil anlegen (auto: wenn ein Modem erkannt wird)
  SCREENABLE_LTE_CONNECTION=Telekom-LTE         NetworkManager-Profil für LTE
  SCREENABLE_LTE_APN=internet.telekom           APN, nur beim Anlegen des Profils
  SCREENABLE_LTE_DNS="1.1.1.1 8.8.8.8"          IPv4-DNS-Server, nur beim Anlegen des Profils
  SCREENABLE_KIOSK_LOCKDOWN=1|0                 Konsolenwechsel und Magic-SysRq sperren
  SCREENABLE_UNATTENDED_UPGRADES=1|0            Sicherheitsupdates automatisch einspielen
  SCREENABLE_REBOOT_TIME=04:00                  Uhrzeit für nötige Neustarts nach Updates
  SCREENABLE_KEEP_RELEASES=3                    aufbewahrte Releases für Rollbacks

Für eine Installation ohne Rückfragen (werden nicht gespeichert):
  SCREENABLE_ADMIN_PASSWORD   Dashboard-Passwort, falls noch keins eingerichtet ist
  SCREENABLE_HOTSPOT_PSK      WLAN-Passwort, falls das Hotspot-Profil noch fehlt
  SCREENABLE_SIM_PIN          SIM-PIN, falls das LTE-Profil noch fehlt und die SIM eine PIN hat
EOF
}

# Wird install.sh allein gestartet (per curl), lädt es das Release-Paket von GitHub,
# prüft die Prüfsumme und startet das darin enthaltene install.sh.
bootstrap() {
  local repo=${SCREENABLE_REPO:-screenable/SignagePlayer}
  local version=${SCREENABLE_VERSION:-latest}
  local token=${SCREENABLE_GITHUB_TOKEN:-}
  local web=${SCREENABLE_GITHUB_WEB:-https://github.com} api=${SCREENABLE_GITHUB_API:-https://api.github.com}
  local asset=screenable-player.tar.gz tmp dir json url name base
  if [ "${EUID}" -ne 0 ]; then
    echo 'Bitte mit sudo ausführen: curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo bash' >&2
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then apt-get update -q && apt-get install -y -q curl ca-certificates; fi
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # Pfad jetzt festhalten
  trap "rm -rf '${tmp}'" EXIT
  echo "Lade Screenable Player (${version}) aus ${repo} …"
  if [ -z "${token}" ]; then
    if [ "${version}" = latest ]; then base="${web}/${repo}/releases/latest/download"; else base="${web}/${repo}/releases/download/${version}"; fi
    if ! curl -fsSL --retry 3 -o "${tmp}/${asset}" "${base}/${asset}" || ! curl -fsSL --retry 3 -o "${tmp}/SHA256SUMS" "${base}/SHA256SUMS"; then
      echo "Download von ${base} fehlgeschlagen. Gibt es das Release ${version}? Bei privatem Repository SCREENABLE_GITHUB_TOKEN setzen (siehe README)." >&2
      exit 1
    fi
  else
    # Private Repositories liefern Release-Dateien nur über die API aus.
    if [ "${version}" = latest ]; then url="${api}/repos/${repo}/releases/latest"; else url="${api}/repos/${repo}/releases/tags/${version}"; fi
    json=$(curl -fsSL --retry 3 -H "Authorization: Bearer ${token}" -H 'Accept: application/vnd.github+json' "${url}") \
      || { echo "Release ${version} nicht abrufbar (Token gültig und für ${repo} freigegeben?)." >&2; exit 1; }
    for name in "${asset}" SHA256SUMS; do
      url=$(printf '%s' "${json}" | tr -d '\n' | grep -o "\"url\": *\"[^\"]*/releases/assets/[0-9]*\"[^}]*\"name\": *\"${name//./\\.}\"" \
        | grep -o 'https\?://[^"]*/releases/assets/[0-9]*' | sed -n 1p || true)
      [ -n "${url}" ] || { echo "Release ${version} enthält ${name} nicht." >&2; exit 1; }
      curl -fsSL --retry 3 -H "Authorization: Bearer ${token}" -H 'Accept: application/octet-stream' -o "${tmp}/${name}" "${url}"
    done
  fi
  if ! (cd "${tmp}" && grep " ${asset}\$" SHA256SUMS | sha256sum -c --quiet - >/dev/null); then
    echo 'Prüfsumme des Pakets stimmt nicht; Abbruch.' >&2
    exit 1
  fi
  tar -xzf "${tmp}/${asset}" -C "${tmp}"
  dir=$(find "${tmp}" -mindepth 2 -maxdepth 2 -name install.sh -printf '%h\n' | sed -n 1p)
  [ -n "${dir}" ] || { echo 'Paket enthält kein install.sh.' >&2; exit 1; }
  echo "Paket $(basename "${dir}") geprüft, starte Installation."
  # Bei curl | bash ist stdin das Skript selbst; Rückfragen kommen vom Terminal.
  if (: < /dev/tty) 2>/dev/null; then bash "${dir}/install.sh" < /dev/tty; else bash "${dir}/install.sh" < /dev/null; fi
}

# Der gesamte Ablauf steckt in Funktionen und startet erst in der letzten Zeile, damit
# bei curl | bash nichts ausgeführt wird, bevor das Skript vollständig geladen ist.
main() {
if [ "${EUID}" -ne 0 ]; then echo 'Bitte mit sudo ausführen: sudo ./install.sh' >&2; exit 1; fi

project_dir=${script_dir}
base=/opt/screenable-player
etc=/etc/screenable-player
state=/var/lib/screenable-player
log=/var/log/screenable-player-install.log
interactive=0
if [ -t 0 ]; then interactive=1; fi
exec > >(tee -a "${log}") 2>&1
echo "=== $(date -Is) Screenable-Installation aus ${project_dir}"

total=12
step_no=0
current_step='Start'
step() { step_no=$((step_no + 1)); current_step=$1; printf '\n==> [%d/%d] %s\n' "${step_no}" "${total}" "$1"; }
ok() { printf '    ✓ %s\n' "$*"; }
note() { printf '    • %s\n' "$*"; }
fail() { printf '    ✗ %s\n' "$*" >&2; exit 1; }
# shellcheck disable=SC2317 # über trap aufgerufen
on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ]; then
    printf '\nAbbruch in Schritt "%s". Protokoll: %s\nUrsache beheben und sudo ./install.sh erneut ausführen; erledigte Schritte werden übersprungen.\n' \
      "${current_step}" "${log}" >&2
  fi
}
trap on_exit EXIT

ask_secret() { # Variablenname, Frage, Bestätigung (1/0)
  local value repeat
  [ "${interactive}" = 1 ] || fail "$2 fehlt. Interaktiv starten oder per Umgebungsvariable setzen (siehe --help)."
  read -r -s -p "    $2: " value < /dev/tty; echo
  if [ "$3" = 1 ]; then
    read -r -s -p '    Wiederholen: ' repeat < /dev/tty; echo
    [ "${value}" = "${repeat}" ] || fail 'Die Eingaben stimmen nicht überein.'
  fi
  printf -v "$1" '%s' "${value}"
}
keyfile_escape() { local v=${1//\\/\\\\}; printf '%s' "${v}"; }
new_uuid() { cat /proc/sys/kernel/random/uuid; }
# Filter lesen die Ausgabe vollständig (kein grep -q/awk exit), sonst kann nmcli
# mit pipefail an SIGPIPE scheitern und ein vorhandenes Profil wirkt wie fehlend.
nm_has() { nmcli -t -f NAME connection show | grep -Fx -- "$1" >/dev/null; }
first_match() { awk -F: -v want="$1" '$2 == want && !found { print $1; found = 1 }'; }
write_keyfile() { # Profilname, Inhalt; Secrets nie über die Kommandozeile an nmcli
  local file="/etc/NetworkManager/system-connections/$1.nmconnection"
  install -d -m 0700 /etc/NetworkManager/system-connections
  (umask 077; printf '%s\n' "$2" > "${file}.tmp")
  mv "${file}.tmp" "${file}"
  nmcli connection reload
}

# Gespeicherte Optionen übernehmen; beim Aufruf gesetzte Variablen haben Vorrang.
if [ -f "${etc}/install.env" ]; then
  while IFS='=' read -r key value; do
    [[ "${key}" =~ ^SCREENABLE_[A-Z_]+$ ]] || continue
    [ -n "${!key+x}" ] || printf -v "${key}" '%s' "${value//\"/}"
  done < "${etc}/install.env"
fi
lockdown=${SCREENABLE_KIOSK_LOCKDOWN:-1}
unattended=${SCREENABLE_UNATTENDED_UPGRADES:-1}
reboot_time=${SCREENABLE_REBOOT_TIME:-04:00}
keep=${SCREENABLE_KEEP_RELEASES:-3}
firewall=${SCREENABLE_FIREWALL:-1}
hotspot_connection=${SCREENABLE_HOTSPOT_CONNECTION:-Giada-Hotspot}
hotspot_ssid=${SCREENABLE_HOTSPOT_SSID:-Giada-WIFI}
hotspot_address=${SCREENABLE_HOTSPOT_ADDRESS:-10.42.0.1}
admin_interfaces=${SCREENABLE_ADMIN_INTERFACES:-}
lte=${SCREENABLE_LTE:-auto}
lte_connection=${SCREENABLE_LTE_CONNECTION:-Telekom-LTE}
lte_apn=${SCREENABLE_LTE_APN:-internet.telekom}
lte_dns=${SCREENABLE_LTE_DNS:-1.1.1.1 8.8.8.8}

save_options() {
  install -d -o root -g root -m 0755 "${etc}"
  cat > "${etc}/install.env" <<EOF
SCREENABLE_KIOSK_LOCKDOWN=${lockdown}
SCREENABLE_UNATTENDED_UPGRADES=${unattended}
SCREENABLE_REBOOT_TIME=${reboot_time}
SCREENABLE_KEEP_RELEASES=${keep}
SCREENABLE_FIREWALL=${firewall}
SCREENABLE_HOTSPOT_CONNECTION="${hotspot_connection}"
SCREENABLE_HOTSPOT_SSID="${hotspot_ssid}"
SCREENABLE_HOTSPOT_ADDRESS=${hotspot_address}
SCREENABLE_ADMIN_INTERFACES="${admin_interfaces}"
SCREENABLE_LTE=${lte}
SCREENABLE_LTE_CONNECTION="${lte_connection}"
SCREENABLE_LTE_APN=${lte_apn}
SCREENABLE_LTE_DNS="${lte_dns}"
EOF
}

# ---------------------------------------------------------------------------
step 'Voraussetzungen prüfen'
[[ "${lockdown}" =~ ^[01]$ && "${unattended}" =~ ^[01]$ && "${firewall}" =~ ^[01]$ ]] || fail 'Schalter müssen 0 oder 1 sein.'
[[ "${lte}" =~ ^(auto|0|1)$ ]] || fail 'SCREENABLE_LTE muss auto, 0 oder 1 sein.'
[[ "${reboot_time}" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || fail 'SCREENABLE_REBOOT_TIME im Format HH:MM angeben.'
if ! [[ "${keep}" =~ ^[0-9]+$ ]] || [ "${keep}" -lt 2 ]; then fail 'SCREENABLE_KEEP_RELEASES muss mindestens 2 sein.'; fi
ipv4='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
[[ "${hotspot_address}" =~ ${ipv4} ]] || fail 'SCREENABLE_HOTSPOT_ADDRESS muss eine IPv4-Adresse sein.'
for dns in ${lte_dns}; do [[ "${dns}" =~ ${ipv4} ]] || fail "Ungültiger DNS-Server: ${dns}"; done
for name in "${hotspot_connection}" "${lte_connection}"; do
  [[ "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,62}$ ]] || fail "Ungültiger Profilname: ${name}"
done
[[ "${hotspot_ssid}" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,30}[A-Za-z0-9._-]$ ]] || fail 'SSID: 2–32 Zeichen aus Buchstaben, Ziffern, Leerzeichen, . _ -'
[[ "${lte_apn}" =~ ^[A-Za-z0-9.-]{1,63}$ ]] || fail 'Ungültiger APN.'
for i in ${admin_interfaces}; do [[ "${i}" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail "Ungültiger Schnittstellenname: ${i}"; done
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != debian ] || [ "${VERSION_ID:-}" != 13 ]; then
  [ "${SCREENABLE_SKIP_OS_CHECK:-0}" = 1 ] || fail "Unterstützt wird Debian 13, gefunden: ${PRETTY_NAME:-unbekannt} (SCREENABLE_SKIP_OS_CHECK=1 überspringt die Prüfung)."
  note "Abweichendes System ${PRETTY_NAME:-unbekannt}, Prüfung übersprungen."
fi
if systemctl is-enabled --quiet display-manager.service 2>/dev/null; then
  note 'Warnung: Ein Display-Manager ist aktiv und konkurriert mit der Kiosk-Sitzung auf tty1.'
fi
ok "${PRETTY_NAME:-Debian}, $(uname -m)"

# ---------------------------------------------------------------------------
step 'Systempakete'
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
  xorg xinit openbox chromium nodejs avahi-daemon x11-xserver-utils xdotool dbus-user-session openssl \
  nftables network-manager modemmanager
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends unclutter-xfixes \
  || note 'unclutter-xfixes nicht verfügbar; Mauszeiger bleibt sichtbar.'
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "${node_major}" -ge 20 ] || fail "Node.js 20 oder neuer benötigt, gefunden ${node_major}."
systemctl enable --now NetworkManager.service ModemManager.service >/dev/null 2>&1 || true
ok "Pakete installiert, Node.js $(node --version)"

# ---------------------------------------------------------------------------
step 'Anwendung bauen'
built=0
if [ -f "${project_dir}/dist/api.js" ] && [ -f "${project_dir}/web/dist/index.html" ]; then built=1; fi
if [ -d "${project_dir}/src" ] && [ -f "${project_dir}/package-lock.json" ]; then
  # Git-Checkout: bauen, wenn noch kein Build existiert oder Quellen neuer sind.
  if [ "${built}" = 0 ] || [ -n "$(find "${project_dir}/src" "${project_dir}/web/src" "${project_dir}/web/index.html" "${project_dir}/package-lock.json" -newer "${project_dir}/dist/api.js" -print -quit)" ]; then
    command -v npm >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -q npm
    builder=${SUDO_USER:-root}
    note "Baue als ${builder} (npm ci && npm run build) …"
    # shellcheck disable=SC2016 # $1 wird erst in der inneren Shell ausgewertet
    runuser -u "${builder}" -- bash -c 'cd "$1" && npm ci --no-audit --no-fund && npm run build' _ "${project_dir}"
    built=1
  fi
fi
[ "${built}" = 1 ] || fail 'Kein Build gefunden. Installationspaket (npm run package) oder Git-Checkout verwenden.'
version=$(node -p "require('${project_dir}/package.json').version")
ok "Version ${version}"

# ---------------------------------------------------------------------------
step 'Benutzer und Verzeichnisse'
getent group screenable >/dev/null || groupadd --system screenable
id screenable-api >/dev/null 2>&1 || useradd --system --gid screenable --home-dir "${state}" --shell /usr/sbin/nologin screenable-api
id screenable >/dev/null 2>&1 || useradd --system --gid screenable --create-home --home-dir /home/screenable --shell /bin/bash screenable
install -d -o screenable-api -g screenable -m 0750 "${state}"
install -d -o screenable -g screenable -m 0700 "${state}/profiles"
install -d -o root -g root -m 0755 "${base}" "${base}/releases" "${etc}"
ok 'screenable-api (Dashboard), screenable (Kiosk)'

# ---------------------------------------------------------------------------
step 'Release vorbereiten'
payload=(package.json README.md docs dist web/dist openbox systemd system avahi chromium xorg)
scripts=(xsession activate-release.sh rollback.sh renew-tls.sh)
checksum=$(cd "${project_dir}" && { find "${payload[@]}" -type f ! -path 'dist/tests/*' -print0; printf 'scripts/%s\0' "${scripts[@]}" diagnostic-server.mjs; } \
  | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
previous=$(readlink -e "${base}/current" 2>/dev/null || true)
release=''
# Ein nach einem Abbruch noch nicht aktiviertes Release mit gleichem Inhalt wiederverwenden.
pending=$(grep -lx "checksum=${checksum}" "${base}"/releases/*/RELEASE 2>/dev/null | sort | tail -n 1 || true)
if [ -n "${previous}" ] && grep -qx "checksum=${checksum}" "${previous}/RELEASE" 2>/dev/null && [ "${SCREENABLE_FORCE_RELEASE:-0}" != 1 ]; then
  app="${previous}"
  ok "Unverändert, aktiv bleibt $(basename "${previous}")"
elif [ -n "${pending}" ] && [ "${SCREENABLE_FORCE_RELEASE:-0}" != 1 ]; then
  release=$(dirname "${pending}")
  app="${release}"
  ok "Release $(basename "${release}") aus einem früheren Lauf wird verwendet"
else
  name="$(date -u +%Y%m%dT%H%M%SZ)-${version}"
  release="${base}/releases/${name}"
  install -d -m 0755 "${release}" "${release}/scripts"
  for item in "${payload[@]}"; do
    install -d -m 0755 "$(dirname "${release}/${item}")"
    cp -a "${project_dir}/${item}" "${release}/${item}"
  done
  rm -rf "${release}/dist/tests"
  for script in "${scripts[@]}"; do install -m 0755 "${project_dir}/scripts/${script}" "${release}/scripts/${script}"; done
  install -m 0644 "${project_dir}/scripts/diagnostic-server.mjs" "${release}/scripts/diagnostic-server.mjs"
  commit=$(git -C "${project_dir}" rev-parse --short HEAD 2>/dev/null || sed -n 's/^commit=//p' "${project_dir}/BUILD" 2>/dev/null || echo unbekannt)
  printf 'version=%s\ncommit=%s\nchecksum=%s\ninstalled=%s\n' "${version}" "${commit:-unbekannt}" "${checksum}" "$(date -u +%FT%TZ)" > "${release}/RELEASE"
  chown -R root:root "${release}"
  chmod -R go-w "${release}"
  app="${release}"
  ok "Neues Release ${name} (wird in Schritt ${total} aktiviert)"
fi

# ---------------------------------------------------------------------------
step 'Firewall'
if [ -z "${admin_interfaces}" ]; then
  # Schnittstelle des Hotspot-Profils, sonst das erste WLAN-Gerät.
  if nm_has "${hotspot_connection}"; then
    admin_interfaces=$(nmcli -g connection.interface-name connection show "${hotspot_connection}")
    [ -n "${admin_interfaces}" ] || admin_interfaces=$(nmcli -g GENERAL.DEVICES connection show "${hotspot_connection}" || true)
  fi
  [ -n "${admin_interfaces}" ] || admin_interfaces=$(nmcli -t -f DEVICE,TYPE device | first_match wifi)
  [ -n "${admin_interfaces}" ] || fail 'Kein WLAN-Gerät gefunden (Firmware, z. B. firmware-iwlwifi?). Alternativ SCREENABLE_ADMIN_INTERFACES setzen.'
fi
save_options
read -r -a interfaces <<< "${admin_interfaces}"
if [ "${firewall}" = 1 ]; then
  list=$(printf '"%s", ' "${interfaces[@]}")
  sed "s/@ADMIN_INTERFACES@/${list%, }/" "${app}/system/firewall.nft" > "${etc}/firewall.nft.new"
  /usr/sbin/nft -c -f "${etc}/firewall.nft.new"
  mv "${etc}/firewall.nft.new" "${etc}/firewall.nft"
  install -o root -g root -m 0644 "${app}/systemd/screenable-firewall.service" /etc/systemd/system/screenable-firewall.service
  systemctl daemon-reload
  systemctl enable screenable-firewall.service >/dev/null
  # Neu laden statt neu starten: Regeln werden ohne ungeschützte Lücke ersetzt.
  systemctl reload-or-restart screenable-firewall.service
  if [ -n "${SSH_CONNECTION:-}" ]; then
    via=$(ip route get "${SSH_CONNECTION%% *}" 2>/dev/null | grep -o 'dev [^ ]*' | cut -d' ' -f2 || true)
    if [ -n "${via}" ] && ! printf '%s\n' "${interfaces[@]}" | grep -Fx -- "${via}" >/dev/null; then
      note "Diese SSH-Sitzung läuft über ${via}: Sie bleibt bestehen, neue Verbindungen darüber sind gesperrt."
    fi
  fi
  ok "Eingehend nur über ${admin_interfaces}"
else
  if systemctl is-enabled --quiet screenable-firewall.service 2>/dev/null; then systemctl disable --now screenable-firewall.service; fi
  rm -f /etc/systemd/system/screenable-firewall.service "${etc}/firewall.nft"
  systemctl daemon-reload
  note 'Firewall deaktiviert (SCREENABLE_FIREWALL=0).'
fi

# ---------------------------------------------------------------------------
step 'Mobilfunk (LTE)'
existing_lte=$(nmcli -t -f NAME,TYPE connection show | first_match gsm)
if [ "${lte}" = 0 ]; then
  note 'Übersprungen (SCREENABLE_LTE=0).'
elif [ -n "${existing_lte}" ]; then
  ok "Profil '${existing_lte}' vorhanden, unverändert"
elif [ "${lte}" = auto ] && ! mmcli -L 2>/dev/null | grep '/Modem/' >/dev/null; then
  note 'Kein Modem erkannt, übersprungen. Mit SCREENABLE_LTE=1 trotzdem anlegen.'
else
  pin=${SCREENABLE_SIM_PIN:-}
  if [ -z "${pin}" ] && [ -z "${SCREENABLE_SIM_PIN+x}" ] && [ "${interactive}" = 1 ]; then
    ask_secret pin 'SIM-PIN (leer lassen, wenn die SIM keine PIN hat)' 0
  fi
  [ -z "${pin}" ] || [[ "${pin}" =~ ^[0-9]{4,8}$ ]] || fail 'Die SIM-PIN besteht aus 4 bis 8 Ziffern.'
  # shellcheck disable=SC2086 # Leerzeichen-getrennte Liste
  dns_list=$(printf '%s;' ${lte_dns})
  write_keyfile "${lte_connection}" "[connection]
id=${lte_connection}
uuid=$(new_uuid)
type=gsm
autoconnect=true

[gsm]
apn=${lte_apn}
auto-config=false
home-only=false${pin:+
pin=${pin}
pin-flags=0}

[ipv4]
method=auto
dns=${dns_list}
dns-priority=600
route-metric=600

[ipv6]
method=auto
dns-priority=600
route-metric=600"
  nmcli connection up "${lte_connection}" >/dev/null 2>&1 \
    || note 'Verbindung wird automatisch aufgebaut, sobald Modem und Netz bereit sind.'
  ok "Profil '${lte_connection}' angelegt (APN ${lte_apn})"
fi

# ---------------------------------------------------------------------------
step 'WLAN-Hotspot'
if nm_has "${hotspot_connection}"; then
  current=$(nmcli -g ipv4.addresses connection show "${hotspot_connection}")
  if [ -z "${current}" ]; then
    # Wirkt ab der nächsten Aktivierung; eine laufende Hotspot-Sitzung bleibt bestehen.
    nmcli connection modify "${hotspot_connection}" ipv4.addresses "${hotspot_address}/24"
    ok "Profil '${hotspot_connection}' vorhanden, Adresse ${hotspot_address} festgelegt (gilt nach Neustart)"
  elif [ "${current%/*}" != "${hotspot_address}" ]; then
    fail "Profil '${hotspot_connection}' nutzt ${current}, erwartet ${hotspot_address}. SCREENABLE_HOTSPOT_ADDRESS anpassen."
  else
    ok "Profil '${hotspot_connection}' vorhanden (${hotspot_address})"
  fi
else
  device=${interfaces[0]}
  [ "$(nmcli -g GENERAL.TYPE device show "${device}" 2>/dev/null)" = wifi ] || fail "${device} ist kein WLAN-Gerät."
  [ "$(nmcli -g WIFI-PROPERTIES.AP device show "${device}" 2>/dev/null)" = yes ] || fail "${device} unterstützt keinen Access-Point-Modus."
  psk=${SCREENABLE_HOTSPOT_PSK:-}
  [ -n "${psk}" ] || ask_secret psk "WLAN-Passwort für '${hotspot_ssid}' (8–63 Zeichen)" 1
  if [ "${#psk}" -lt 8 ] || [ "${#psk}" -gt 63 ] || ! [[ "${psk}" =~ ^[[:print:]]+$ ]] || [[ "${psk}" == " "* || "${psk}" == *" " ]]; then
    fail 'Das WLAN-Passwort braucht 8–63 druckbare Zeichen ohne Leerzeichen am Anfang oder Ende.'
  fi
  # WPA2 mit CCMP; ältere TKIP-Verschlüsselung bleibt aus.
  write_keyfile "${hotspot_connection}" "[connection]
id=${hotspot_connection}
uuid=$(new_uuid)
type=wifi
interface-name=${device}
autoconnect=true

[wifi]
mode=ap
ssid=${hotspot_ssid}
band=bg

[wifi-security]
key-mgmt=wpa-psk
proto=rsn
pairwise=ccmp
group=ccmp
psk=$(keyfile_escape "${psk}")

[ipv4]
method=shared
address1=${hotspot_address}/24
never-default=true

[ipv6]
method=disabled"
  nmcli connection up "${hotspot_connection}" >/dev/null || fail 'Hotspot konnte nicht gestartet werden (journalctl -u NetworkManager).'
  ok "Hotspot '${hotspot_ssid}' auf ${device} angelegt und gestartet (${hotspot_address})"
fi
host=$(hostname -s)
# Gerätename auch für Clients ohne mDNS (z. B. Android) über den Hotspot-DNS.
install -d -m 0755 /etc/NetworkManager/dnsmasq-shared.d
printf '# Verwaltet von install.sh\naddress=/%s.local/%s\naddress=/%s/%s\n' "${host}" "${hotspot_address}" "${host}" "${hotspot_address}" \
  > /etc/NetworkManager/dnsmasq-shared.d/screenable.conf
avahi_conf=/etc/avahi/avahi-daemon.conf
if [ -f "${avahi_conf}" ]; then
  allow=$(IFS=,; echo "${interfaces[*]}")
  if grep -q '^allow-interfaces=' "${avahi_conf}"; then sed -i "s/^allow-interfaces=.*/allow-interfaces=${allow}/" "${avahi_conf}"
  elif grep -q '^#allow-interfaces=' "${avahi_conf}"; then sed -i "0,/^#allow-interfaces=.*/s//allow-interfaces=${allow}/" "${avahi_conf}"
  else sed -i "/^\[server\]/a allow-interfaces=${allow}" "${avahi_conf}"; fi
  systemctl try-restart avahi-daemon.service || true
fi
ok "Name ${host}.local und ${host} zeigen im Hotspot auf ${hotspot_address}"

# ---------------------------------------------------------------------------
step 'Administratorpasswort'
if [ -f "${state}/secrets.json" ]; then
  ok 'Bereits eingerichtet (ändern: cli.js passwd, siehe docs/operations.md)'
elif [ -n "${SCREENABLE_ADMIN_PASSWORD:-}" ]; then
  printf '%s\n' "${SCREENABLE_ADMIN_PASSWORD}" | runuser -u screenable-api -- /usr/bin/node "${app}/dist/cli.js" init >/dev/null
  ok 'Aus SCREENABLE_ADMIN_PASSWORD gesetzt'
else
  [ "${interactive}" = 1 ] || fail 'Kein Passwort eingerichtet. Interaktiv starten oder SCREENABLE_ADMIN_PASSWORD setzen.'
  runuser -u screenable-api -- /usr/bin/node "${app}/dist/cli.js" init < /dev/tty
  ok 'Gesetzt'
fi

# ---------------------------------------------------------------------------
step 'TLS-Zertifikat'
crt="${etc}/tls.crt"
if [ ! -s "${crt}" ] || [ ! -s "${etc}/tls.key" ]; then
  "${app}/scripts/renew-tls.sh" >/dev/null
  ok "Neu erstellt für ${host}.local und ${hotspot_address}"
elif openssl x509 -in "${crt}" -noout -checkip "${hotspot_address}" | grep 'does match' >/dev/null \
  && openssl x509 -in "${crt}" -noout -checkhost "${host}.local" | grep 'does match' >/dev/null \
  && openssl x509 -in "${crt}" -noout -checkend $((30 * 86400)) >/dev/null; then
  ok "Gültig bis $(openssl x509 -in "${crt}" -noout -enddate | cut -d= -f2)"
elif [ "$(openssl x509 -in "${crt}" -noout -issuer | cut -d= -f2-)" = "$(openssl x509 -in "${crt}" -noout -subject | cut -d= -f2-)" ]; then
  # Selbstsigniert, aber falscher Name, fehlende Adresse oder bald abgelaufen.
  "${app}/scripts/renew-tls.sh" >/dev/null
  note 'Selbstsigniertes Zertifikat erneuert. Auf den Verwaltungsgeräten neu importieren!'
else
  note "Zertifikat einer eigenen PKI passt nicht zu ${host}.local/${hotspot_address} oder läuft bald ab; bitte selbst erneuern."
fi
openssl x509 -in "${crt}" -noout -fingerprint -sha256 | sed 's/^/    /'

# ---------------------------------------------------------------------------
step 'Automatische Sicherheitsupdates'
if [ "${unattended}" = 1 ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  cat > /etc/apt/apt.conf.d/52screenable-unattended-upgrades <<EOF
// Verwaltet von install.sh (SCREENABLE_REBOOT_TIME).
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "${reboot_time}";
EOF
  ok "Aktiv, nötige Neustarts um ${reboot_time}"
else
  rm -f /etc/apt/apt.conf.d/52screenable-unattended-upgrades
  note 'Abgeschaltet (SCREENABLE_UNATTENDED_UPGRADES=0).'
fi

# ---------------------------------------------------------------------------
step 'Anwendung aktivieren'
health() { /usr/bin/node -e "require('https').get({host:'127.0.0.1',port:8443,path:'/api/v1/health',rejectUnauthorized:false,timeout:2000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; }
if [ -n "${release}" ]; then
  if ! "${release}/scripts/activate-release.sh"; then
    if [ -n "${previous}" ] && [ -x "${previous}/scripts/activate-release.sh" ]; then
      note "Health-Check fehlgeschlagen, Rollback auf $(basename "${previous}")."
      # Das fehlerhafte Release entfernen, damit es kein späteres Rollback-Ziel wird.
      if "${previous}/scripts/activate-release.sh"; then rm -rf "${release}"; fi
    fi
    fail 'Neues Release startet nicht. Logs: journalctl -u screenable-api -n 50'
  fi
  # Programmdateien der Version 0.1 lagen direkt unter /opt/screenable-player.
  rm -rf "${base}/dist" "${base}/web" "${base}/scripts" "${base}/package.json"
  mapfile -t releases < <(find "${base}/releases" -mindepth 1 -maxdepth 1 -type d | sort)
  for ((i = 0; i < ${#releases[@]} - keep; i++)); do
    r=${releases[$i]}
    if [ "${r}" != "${release}" ] && [ "${r}" != "${previous}" ]; then rm -rf "${r}"; fi
  done
  ok "Aktiv: $(basename "${release}")"
elif health; then
  ok "Dashboard antwortet ($(basename "${app}"))"
else
  note 'Dashboard antwortet nicht, aktiviere das aktuelle Release erneut …'
  "${app}/scripts/activate-release.sh" || fail 'Dashboard startet nicht. Logs: journalctl -u screenable-api -n 50'
  ok "Aktiv: $(basename "${app}")"
fi

# ---------------------------------------------------------------------------
current_step='Abschluss'
printf '\nFertig. Im Hotspot "%s" erreichbar:\n  https://%s:8443\n  https://%s.local:8443\n' "${hotspot_ssid}" "${hotspot_address}" "${host}"
if [ -z "${previous}" ]; then
  echo 'Erstinstallation: Ein Neustart startet den Kiosk und übernimmt alle Einstellungen.'
  if [ "${interactive}" = 1 ]; then
    read -r -p 'Jetzt neu starten? [j/N] ' answer < /dev/tty
    if [[ "${answer}" =~ ^[jJyY]$ ]]; then systemctl reboot; fi
  fi
fi
}

if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then usage; exit 0; fi
script_dir=''
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); fi
if [ -n "${script_dir}" ] && [ -f "${script_dir}/package.json" ]; then main "$@"; else bootstrap "$@"; fi
exit
