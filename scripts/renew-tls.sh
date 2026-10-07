#!/bin/bash
# Erzeugt ein selbstsigniertes TLS-Zertifikat für <hostname>.local und lädt es ohne
# Neustart in die API. Danach muss das neue Zertifikat auf den Verwaltungsgeräten
# erneut als vertrauenswürdig importiert werden.
#   sudo /opt/screenable-player/current/scripts/renew-tls.sh
#   sudo .../renew-tls.sh --if-missing    # nur anlegen, wenn noch keins existiert
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then echo 'Bitte mit sudo ausführen.' >&2; exit 1; fi
dir=/etc/screenable-player
if [ "${1:-}" = '--if-missing' ] && [ -s "${dir}/tls.key" ] && [ -s "${dir}/tls.crt" ]; then exit 0; fi

name=$(hostname -s)
SCREENABLE_HOTSPOT_ADDRESS=10.42.0.1
# shellcheck disable=SC1091
if [ -f "${dir}/install.env" ]; then . "${dir}/install.env"; fi
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT
# 825 Tage und extendedKeyUsage=serverAuth: Mindestanforderungen von macOS/iOS,
# auch für manuell vertraute Zertifikate. P-256 wird von allen Browsern unterstützt.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 -days 825 -nodes \
  -keyout "${tmp}/tls.key" -out "${tmp}/tls.crt" -subj "/CN=${name}.local" \
  -addext "subjectAltName=DNS:${name}.local,DNS:${name},IP:${SCREENABLE_HOTSPOT_ADDRESS}" \
  -addext "extendedKeyUsage=serverAuth"

install -d -o root -g root -m 0755 "${dir}"
install -o screenable-api -g screenable -m 0600 "${tmp}/tls.key" "${dir}/tls.key"
install -o root -g root -m 0644 "${tmp}/tls.crt" "${dir}/tls.crt"
if systemctl is-active --quiet screenable-api.service; then systemctl reload screenable-api.service; fi
openssl x509 -in "${dir}/tls.crt" -noout -subject -enddate -fingerprint -sha256
