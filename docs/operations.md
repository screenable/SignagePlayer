# Installation und Betrieb

## Zugriff und TLS

Der Installer erstellt ein selbstsigniertes Zertifikat für `<hostname>.local` unter `/etc/screenable-player`. Das Dashboard lauscht ausschließlich auf HTTPS-Port 8443. Das Zertifikat auf dem Verwaltungsgerät als vertrauenswürdig importieren oder durch ein Zertifikat der eigenen lokalen PKI ersetzen. Danach `sudo systemctl restart screenable-api` ausführen. Port 8443 nur im vertrauenswürdigen LAN/VPN freigeben; keine Weiterleitung ins Internet.

Avahi veröffentlicht den Hostnamen per mDNS und den `_https._tcp`-Dienst. Bei VLANs oder deaktiviertem Multicast die Geräte-IP beziehungsweise internes DNS verwenden; das Zertifikat muss dann zum verwendeten Namen passen.

## Dienste und Daten

| Pfad/Dienst | Zweck |
|---|---|
| `/opt/screenable-player` | gebaute, root-eigene Programmdateien |
| `/var/lib/screenable-player/config.json` | API-schreibbare Konfiguration, für Player lesbar |
| `/var/lib/screenable-player/secrets.json` | Passwort-Hash, nur für API lesbar |
| `/var/lib/screenable-player/profiles/single` | Chromium-Profil des Player-Benutzers |
| `/run/screenable-player` | Status und begrenzte Player-Aktionen |
| `screenable-api.service` | HTTPS-Dashboard, unabhängig von X11 |
| `screenable-player.service` | User-Dienst in der X11-Session |

Der API-Dienst legt `/run/screenable-player` bei jedem Start neu an. Nach einem Kaltstart meldet sich `screenable` auf `tty1` automatisch an, startet Xorg/Openbox und darin den Player-User-Dienst. Ein zweiter Display-Manager oder eine bereits belegte `tty1` muss zuvor entfernt bzw. angepasst werden.

## Diagnose

```sh
systemctl status screenable-api avahi-daemon getty@tty1
journalctl -u screenable-api -b --no-pager -n 100
journalctl _UID="$(id -u screenable)" -b --no-pager -n 150
sudo -u screenable DISPLAY=:0 xrandr --query
cat /run/screenable-player/status.json
```

`/api/v1/health` meldet nur die API-Laufzeit. Der angemeldete Status zeigt den Player-Zustand; ein mehr als zehn Sekunden altes Statusdokument wird als `offline` markiert. Ein lebender Chromium-Prozess beweist noch keine korrekte WebGL- oder Audio-Ausgabe.

## Update

Vor einem Update `/var/lib/screenable-player` sichern. Neue Version auf einem Testgerät bauen und `scripts/install-debian13.sh` erneut ausführen. Das Skript überschreibt keine vorhandene Konfiguration, Secrets oder TLS-Schlüssel. Anschließend `sudo systemctl restart screenable-api` und das Gerät neu starten. Das automatische Rollback ist noch offen.
