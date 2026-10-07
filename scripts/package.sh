#!/bin/bash
# Erzeugt release/screenable-player-<version>.tar.gz: fertig gebaut, ohne node_modules.
# Auf dem Gerät: tar xzf … && cd screenable-player-<version> && sudo ./install.sh
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "${root}"
if [ ! -f dist/api.js ] || [ ! -f web/dist/index.html ]; then echo 'Zuerst npm run build ausführen.' >&2; exit 1; fi
version=$(node -p "require('./package.json').version")
name="screenable-player-${version}"
out="${root}/release"
rm -rf "${out:?}/${name}" "${out}/${name}.tar.gz"
mkdir -p "${out}/${name}"
cp -a install.sh package.json README.md docs dist openbox systemd system avahi chromium xorg scripts "${out}/${name}/"
mkdir -p "${out}/${name}/web" && cp -a web/dist "${out}/${name}/web/dist"
rm -rf "${out}/${name}/dist/tests" "${out}/${name}/scripts/package.sh"
printf 'version=%s\ncommit=%s\nbuilt=%s\n' "${version}" "$(git rev-parse --short HEAD 2>/dev/null || echo unbekannt)" "$(date -u +%FT%TZ)" > "${out}/${name}/BUILD"
tar -C "${out}" --owner=0 --group=0 -czf "${out}/${name}.tar.gz" "${name}"
rm -rf "${out:?}/${name}"
echo "${out}/${name}.tar.gz"
