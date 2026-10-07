#!/bin/bash
# Beschränkt den Verwaltungszugang (Dashboard, SSH, mDNS) auf den Hotspot und macht
# das Gerät dort per IP-Adresse und Namen erreichbar. Über LTE (IPv4 und IPv6) sind
# keine eingehenden Verbindungen möglich. Einstellungen aus /etc/screenable-player/install.env.
#   sudo /opt/screenable-player/current/scripts/configure-access.sh
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then echo 'Bitte mit sudo ausführen.' >&2; exit 1; fi
release=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck disable=SC1091
if [ -f /etc/screenable-player/install.env ]; then . /etc/screenable-player/install.env; fi
firewall=${SCREENABLE_FIREWALL:-1}
read -r -a interfaces <<< "${SCREENABLE_ADMIN_INTERFACES:-wlp2s0}"
connection=${SCREENABLE_HOTSPOT_CONNECTION:-Giada-Hotspot}
address=${SCREENABLE_HOTSPOT_ADDRESS:-10.42.0.1}
name=$(hostname -s)

[[ "${firewall}" =~ ^[01]$ ]] || { echo 'SCREENABLE_FIREWALL muss 0 oder 1 sein.' >&2; exit 1; }
[ "${#interfaces[@]}" -gt 0 ] || { echo 'SCREENABLE_ADMIN_INTERFACES ist leer.' >&2; exit 1; }
for i in "${interfaces[@]}"; do
  [[ "${i}" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || { echo "Ungültiger Schnittstellenname: ${i}" >&2; exit 1; }
done
[[ "${address}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'SCREENABLE_HOTSPOT_ADDRESS muss eine IPv4-Adresse sein.' >&2; exit 1; }

# Feste Hotspot-Adresse, damit https://<adresse>:8443 dauerhaft gilt. NetworkManager
# vergibt sonst automatisch eine Adresse aus 10.42.x.0/24. Wirkt ab der nächsten
# Aktivierung des Hotspots (spätestens nach einem Neustart).
if command -v nmcli >/dev/null 2>&1 && nmcli -t -f NAME connection show | grep -Fxq "${connection}"; then
  current=$(nmcli -g ipv4.addresses connection show "${connection}")
  if [ -z "${current}" ]; then
    nmcli connection modify "${connection}" ipv4.addresses "${address}/24"
    echo "Hotspot-Adresse ${address}/24 im Profil ${connection} festgelegt."
  elif [ "${current%/*}" != "${address}" ]; then
    echo "Warnung: Profil ${connection} nutzt ${current}, erwartet ${address}. SCREENABLE_HOTSPOT_ADDRESS anpassen." >&2
  fi
else
  echo "Hinweis: NetworkManager-Profil ${connection} nicht gefunden; Hotspot-Adresse nicht festgelegt." >&2
fi

# Gerätename per DNS des Hotspots. Android und ältere Clients fragen .local-Namen
# per normalem DNS statt mDNS ab; der von NetworkManager gestartete dnsmasq antwortet.
if [ -d /etc/NetworkManager ]; then
  install -d -m 0755 /etc/NetworkManager/dnsmasq-shared.d
  printf '# Verwaltet von Screenable (configure-access.sh).\naddress=/%s.local/%s\naddress=/%s/%s\n' \
    "${name}" "${address}" "${name}" "${address}" > /etc/NetworkManager/dnsmasq-shared.d/screenable.conf
fi

# mDNS nur im Hotspot anbieten, nicht über LTE oder fremde Netze.
avahi_conf=/etc/avahi/avahi-daemon.conf
if [ -f "${avahi_conf}" ]; then
  allow=$(IFS=,; echo "${interfaces[*]}")
  if grep -q '^allow-interfaces=' "${avahi_conf}"; then
    sed -i "s/^allow-interfaces=.*/allow-interfaces=${allow}/" "${avahi_conf}"
  elif grep -q '^#allow-interfaces=' "${avahi_conf}"; then
    sed -i "0,/^#allow-interfaces=.*/s//allow-interfaces=${allow}/" "${avahi_conf}"
  else
    sed -i "/^\[server\]/a allow-interfaces=${allow}" "${avahi_conf}"
  fi
  systemctl try-restart avahi-daemon.service || true
fi

if [ "${firewall}" = 1 ]; then
  list=$(printf '"%s", ' "${interfaces[@]}")
  sed "s/@ADMIN_INTERFACES@/${list%, }/" "${release}/system/firewall.nft" > /etc/screenable-player/firewall.nft.new
  /usr/sbin/nft -c -f /etc/screenable-player/firewall.nft.new
  mv /etc/screenable-player/firewall.nft.new /etc/screenable-player/firewall.nft
  install -o root -g root -m 0644 "${release}/systemd/screenable-firewall.service" /etc/systemd/system/screenable-firewall.service
  systemctl daemon-reload
  systemctl enable screenable-firewall.service >/dev/null
  # Neu laden statt neu starten: Die Regeln werden ohne ungeschützte Lücke ersetzt.
  systemctl reload-or-restart screenable-firewall.service
  if [ -n "${SSH_CONNECTION:-}" ]; then
    via=$(ip route get "${SSH_CONNECTION%% *}" 2>/dev/null | grep -o 'dev [^ ]*' | cut -d' ' -f2 || true)
    if [ -n "${via}" ] && ! printf '%s\n' "${interfaces[@]}" | grep -Fxq "${via}"; then
      echo "Warnung: Diese SSH-Sitzung läuft über ${via}. Sie bleibt bestehen, neue Verbindungen über ${via} sind gesperrt." >&2
    fi
  fi
  echo "Firewall aktiv: Verwaltung nur über ${interfaces[*]}."
else
  if systemctl is-enabled --quiet screenable-firewall.service 2>/dev/null; then
    systemctl disable --now screenable-firewall.service
  fi
  rm -f /etc/systemd/system/screenable-firewall.service /etc/screenable-player/firewall.nft
  systemctl daemon-reload
  echo 'Firewall deaktiviert.' >&2
fi
echo "Im Hotspot erreichbar: https://${address}:8443 und https://${name}.local:8443"
