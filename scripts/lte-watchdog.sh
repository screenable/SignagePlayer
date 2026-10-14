#!/bin/bash
# Prüft alle zwei Minuten (screenable-lte-watchdog.timer), ob über LTE wirklich Daten
# fließen. NetworkManager meldet eine Verbindung auch dann als aktiv, wenn das Modem
# nach dem Booten keinen Verkehr durchlässt; erst ein Neuaufbau hilft dann.
# Nach drei Fehlschlägen in Folge wird die Verbindung neu aufgebaut.
set -euo pipefail

SCREENABLE_LTE=auto
SCREENABLE_LTE_CONNECTION=Telekom-LTE
# shellcheck disable=SC1091
if [ -f /etc/screenable-player/install.env ]; then . /etc/screenable-player/install.env; fi
conn=${SCREENABLE_LTE_CONNECTION}
counter=/run/screenable-lte-failures
max_failures=3

[ "${SCREENABLE_LTE}" != 0 ] || exit 0
nmcli -t -f NAME connection show | grep -Fx -- "${conn}" >/dev/null || exit 0
mmcli -L 2>/dev/null | grep '/Modem/' >/dev/null || exit 0

state=$(nmcli -g GENERAL.STATE connection show "${conn}" 2>/dev/null || true)
if [ "${state}" != activated ]; then
  [ "${state}" = activating ] && exit 0
  echo "LTE '${conn}' ist nicht aktiv, verbinde."
  nmcli connection up "${conn}" >/dev/null 2>&1 || echo "Verbindungsaufbau für '${conn}' fehlgeschlagen."
  rm -f "${counter}"
  exit 0
fi

iface=$(nmcli -g GENERAL.IP-IFACE connection show "${conn}" 2>/dev/null || true)
for host in 1.1.1.1 8.8.8.8 2606:4700:4700::1111; do
  if ping -q -c 2 -W 5 ${iface:+-I "${iface}"} "${host}" >/dev/null 2>&1; then
    if [ -f "${counter}" ]; then echo "LTE '${conn}' überträgt wieder Daten."; rm -f "${counter}"; fi
    exit 0
  fi
done

failures=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))
echo "${failures}" > "${counter}"
echo "LTE '${conn}' aktiv, aber ohne Datenverkehr (${failures}/${max_failures})."
if [ "${failures}" -ge "${max_failures}" ]; then
  echo "Baue LTE '${conn}' neu auf."
  nmcli connection down "${conn}" >/dev/null 2>&1 || true
  nmcli connection up "${conn}" >/dev/null 2>&1 || echo "Neuaufbau von '${conn}' fehlgeschlagen."
  rm -f "${counter}"
fi
