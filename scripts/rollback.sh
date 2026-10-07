#!/bin/bash
# Schaltet auf ein früheres Release zurück.
#   sudo /opt/screenable-player/current/scripts/rollback.sh            # vorheriges Release
#   sudo /opt/screenable-player/current/scripts/rollback.sh <name>     # bestimmtes Release
#   sudo /opt/screenable-player/current/scripts/rollback.sh --list
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then echo 'Bitte mit sudo ausführen.' >&2; exit 1; fi
base=/opt/screenable-player
current=$(readlink -e "${base}/current" || true)
mapfile -t releases < <(find "${base}/releases" -mindepth 1 -maxdepth 1 -type d | sort)

if [ "${1:-}" = '--list' ]; then
  for r in "${releases[@]}"; do
    if [ "${r}" = "${current}" ]; then echo "* $(basename "${r}")"; else echo "  $(basename "${r}")"; fi
  done
  exit 0
fi

target=''
if [ -n "${1:-}" ]; then
  target="${base}/releases/$(basename "$1")"
else
  # Release-Namen beginnen mit dem UTC-Zeitstempel und sind daher chronologisch sortiert.
  for r in "${releases[@]}"; do
    [ "${r}" = "${current}" ] && break
    target="${r}"
  done
fi
if [ -z "${target}" ] || [ ! -x "${target}/scripts/activate-release.sh" ]; then
  echo 'Kein passendes früheres Release gefunden. Verfügbar:' >&2
  printf '  %s\n' "${releases[@]##*/}" >&2
  exit 1
fi
if [ "${target}" = "${current}" ]; then echo "Bereits aktiv: $(basename "${target}")"; exit 0; fi
"${target}/scripts/activate-release.sh"
