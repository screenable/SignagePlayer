# Installation und Betrieb

## Installationsoptionen

`scripts/install-debian13.sh` liest optionale Umgebungsvariablen und speichert sie in `/etc/screenable-player/install.env`, damit Updates und Rollbacks dieselben Einstellungen verwenden:

| Variable | Standard | Wirkung |
|---|---|---|
| `SCREENABLE_KIOSK_LOCKDOWN` | `1` | Sperrt Konsolenwechsel (Strg+Alt+F1–F12) und Magic-SysRq für Geräte mit öffentlich zugänglicher Tastatur |
| `SCREENABLE_UNATTENDED_UPGRADES` | `1` | Spielt Debian-Sicherheitsupdates (inkl. Chromium) automatisch ein |
| `SCREENABLE_REBOOT_TIME` | `04:00` | Uhrzeit für Neustarts, die ein Update erfordert |
| `SCREENABLE_KEEP_RELEASES` | `3` | Anzahl aufbewahrter Releases für Rollbacks |
| `SCREENABLE_FIREWALL` | `1` | Eingehende Verbindungen nur aus dem Hotspot (siehe unten) |
| `SCREENABLE_HOTSPOT_CONNECTION` | `Giada-Hotspot` | NetworkManager-Profil des Hotspots |
| `SCREENABLE_ADMIN_INTERFACES` | Gerät des aktiven Hotspots, sonst `wlp2s0` | Schnittstellen mit Verwaltungszugang, durch Leerzeichen getrennt |
| `SCREENABLE_HOTSPOT_ADDRESS` | `10.42.0.1` | Feste Adresse des Geräts im Hotspot |

Beispiel: `sudo SCREENABLE_REBOOT_TIME=05:30 bash scripts/install-debian13.sh`. Beim Aufruf gesetzte Werte haben Vorrang vor den gespeicherten.

## Netzwerkzugang

Das Gerät geht über LTE ins Internet und spannt einen eigenen WLAN-Hotspot auf. Verwaltet wird es **nur aus dem Hotspot**: Dashboard, SSH und mDNS sind ausschließlich dort erreichbar. Über LTE (IPv4 und die öffentliche IPv6-Adresse) nimmt das Gerät keine Verbindungen an; eine Fernwartung über LTE ist nicht vorgesehen.

Im Hotspot ist das Dashboard erreichbar unter:

- `https://10.42.0.1:8443` – feste Adresse, im NetworkManager-Profil eingetragen
- `https://<hostname>.local:8443` – per mDNS (Avahi) und zusätzlich über den DNS des Hotspots, weil Android `.local`-Namen oft nicht per mDNS auflöst

`scripts/configure-access.sh` setzt das um und läuft bei jeder Installation:

| Baustein | Wirkung |
|---|---|
| `screenable-firewall.service` | Lädt `/etc/screenable-player/firewall.nft` vor dem Netzwerkstart. Eingehend nur Loopback, Antworten auf eigene Verbindungen und die Hotspot-Schnittstelle; für LTE nur IPv6-Router-Advertisements und Neighbor Discovery. Von Docker veröffentlichte Ports sind nur aus dem Hotspot und von lokalen Containern erreichbar. |
| NetworkManager-Profil | `ipv4.addresses 10.42.0.1/24` im Hotspot-Profil, falls dort noch keine Adresse steht |
| `/etc/NetworkManager/dnsmasq-shared.d/screenable.conf` | Hotspot-DNS beantwortet `<hostname>.local` und `<hostname>` mit der Hotspot-Adresse |
| `/etc/avahi/avahi-daemon.conf` | `allow-interfaces=` auf die Hotspot-Schnittstelle |

Die Firewall nutzt eine eigene nftables-Tabelle (`inet screenable`) und ersetzt keine Regeln von NetworkManager (Hotspot-NAT, DHCP, DNS) oder Docker; `nftables.service` bleibt deaktiviert. Hotspot-Clients kommen weiterhin über LTE ins Internet. Änderungen an Hotspot-Adresse und -DNS wirken ab der nächsten Aktivierung des Hotspots, spätestens nach einem Neustart.

Wird das Installationsskript per SSH über eine andere Schnittstelle ausgeführt, bleibt diese Sitzung bestehen, neue Verbindungen dorthin sind danach gesperrt. Für Ethernet als zusätzlichen Verwaltungszugang `SCREENABLE_ADMIN_INTERFACES="wlp2s0 eno1"` setzen; zum Abschalten `SCREENABLE_FIREWALL=0`. Den Zustand prüfen mit `sudo nft list table inet screenable`.

## Zugriff und TLS

Der Installer erstellt ein selbstsigniertes Zertifikat (ECDSA P-256, 825 Tage, `extendedKeyUsage=serverAuth`) für `<hostname>.local`, `<hostname>` und die Hotspot-Adresse unter `/etc/screenable-player`. Diese Werte sind die Mindestanforderungen von macOS/iOS, auch für manuell vertraute Zertifikate. Das Dashboard lauscht ausschließlich auf HTTPS-Port 8443. Das Zertifikat auf dem Verwaltungsgerät als vertrauenswürdig importieren oder durch ein Zertifikat der eigenen lokalen PKI ersetzen. Danach `sudo systemctl reload screenable-api` ausführen; die API lädt das Zertifikat ohne Neustart und ohne Sitzungen zu verlieren. Die Firewall beschränkt Port 8443 auf den Hotspot.

Das Dashboard warnt 30 Tage vor Ablauf des Zertifikats. Neues selbstsigniertes Zertifikat erzeugen und laden:

```sh
sudo /opt/screenable-player/current/scripts/renew-tls.sh
```

Ältere Zertifikate enthalten die Hotspot-Adresse nicht (der Installer weist darauf hin); mit Version 0.1 erzeugte sind außerdem RSA-Zertifikate mit 365 Tagen Laufzeit ohne `serverAuth`, die Apple-Geräte ablehnen. Dort einmal `renew-tls.sh` ausführen und das neue Zertifikat erneut importieren.

Avahi veröffentlicht den Hostnamen per mDNS und den `_https._tcp`-Dienst, nur im Hotspot.

## Passwort

```sh
sudo runuser -u screenable-api -- node /opt/screenable-player/current/dist/cli.js passwd
```

Die API übernimmt das neue Passwort sofort und meldet alle bestehenden Dashboard-Sitzungen ab. Dasselbe Kommando setzt ein vergessenes Passwort zurück. Nach fünf Fehlversuchen sperrt die API Anmeldungen von dieser IP-Adresse für 15 Minuten.

## Dienste und Daten

| Pfad/Dienst | Zweck |
|---|---|
| `/opt/screenable-player/releases/<zeit>-<version>` | gebaute, root-eigene Programmdateien je Release; `RELEASE` nennt Version und Commit |
| `/opt/screenable-player/current` | Symlink auf das aktive Release |
| `/var/lib/screenable-player/config.json` | API-schreibbare Konfiguration, für Player lesbar; `config.json.bak` ist der Vorgänger |
| `/var/lib/screenable-player/secrets.json` | Passwort-Hash, nur für API lesbar |
| `/var/lib/screenable-player/profiles/single` | Chromium-Profil des Player-Benutzers |
| `/run/screenable-player` | Status und begrenzte Player-Aktionen; per `tmpfiles.d` beim Booten angelegt |
| `/etc/chromium/policies/managed/screenable-kiosk.json` | Chromium-Richtlinien für den Kiosk |
| `/etc/X11/xorg.conf.d/10-screenable-kiosk.conf` | kein Bildschirmschoner, kein DPMS |
| `screenable-api.service` | HTTPS-Dashboard, unabhängig von X11, mit systemd-Sandboxing |
| `screenable-player.service` | User-Dienst in der X11-Session |

Nach einem Kaltstart meldet sich `screenable` auf `tty1` automatisch an, startet Xorg/Openbox und darin den Player-User-Dienst. Ein zweiter Display-Manager oder eine bereits belegte `tty1` muss zuvor entfernt bzw. angepasst werden.

## Kiosk-Absicherung

Für Geräte mit Tastatur oder Gamepad im öffentlichen Bereich:

- **Openbox** startet mit `openbox/rc.xml` aus dem Release: kein Desktop-Menü (dort läge sonst „Terminal“), keine Tastenkürzel, keine Arbeitsflächen. Der Mauszeiger wird nach drei Sekunden ohne Bewegung ausgeblendet (`unclutter-xfixes`).
- **Chromium-Richtlinien** sperren Entwicklertools, Downloads, Drucken, Dateidialoge, Inkognito-/Gastfenster, Erweiterungen sowie `file://`- und `chrome://`-Seiten (außer `chrome://gpu` für den Hardwaretest). Benachrichtigungen und Standortabfragen werden abgelehnt; Kamera und Mikrofon fragen weiterhin nach. Für Inhalte, die Kamera oder Mikrofon brauchen, `VideoCaptureAllowedUrls`/`AudioCaptureAllowedUrls` in der Richtliniendatei ergänzen.
- **Lockdown** (`SCREENABLE_KIOSK_LOCKDOWN=1`): kein Wechsel auf Textkonsolen, Magic-SysRq aus. Für Wartung am Gerät mit `SCREENABLE_KIOSK_LOCKDOWN=0` neu installieren und neu starten; SSH ist nicht betroffen.

Chromium-eigene Kürzel zum Schließen (Strg+W, Strg+Umschalt+Q) lassen sich nicht per Richtlinie sperren. Der Player startet den Browser dann nach der eingestellten Verzögerung neu.

## Updates und Rollback

Neue Version auf einem Testgerät prüfen, dann auf dem Gerät bauen bzw. den Build kopieren und den Installer erneut ausführen:

```sh
npm ci && npm run build
sudo bash scripts/install-debian13.sh
```

Der Installer legt ein neues Release an, installiert dessen Systemdateien, schaltet `current` um, startet API und Player neu und wartet auf `/api/v1/health`. Schlägt das fehl, aktiviert er automatisch das vorherige Release und entfernt das fehlerhafte. Konfiguration, Secrets und TLS-Schlüssel werden nie überschrieben. Änderungen an Xorg-Dateien wirken erst nach einem Neustart.

```sh
sudo /opt/screenable-player/current/scripts/rollback.sh --list   # Releases anzeigen
sudo /opt/screenable-player/current/scripts/rollback.sh          # auf das vorherige zurück
sudo /opt/screenable-player/current/scripts/rollback.sh <name>   # auf ein bestimmtes Release
```

Debian-Sicherheitsupdates spielt `unattended-upgrades` täglich ein. Erfordert ein Update einen Neustart (Kernel, Bibliotheken), startet das Gerät zur eingestellten Uhrzeit neu. Vor größeren Updates `/var/lib/screenable-player` sichern.

## Chromium-Zusatzflags

Am Gerät erprobte Flags, etwa für die Videobeschleunigung, ohne Codeänderung setzen:

```sh
sudo mkdir -p /etc/systemd/user/screenable-player.service.d
printf '[Service]\nEnvironment=SCREENABLE_CHROMIUM_FLAGS=--enable-features=VaapiVideoDecoder\n' \
  | sudo tee /etc/systemd/user/screenable-player.service.d/flags.conf
```

Danach das Gerät neu starten. Nur `--`-Optionen sind erlaubt; `--no-sandbox`, `--disable-web-security` und `--ignore-certificate-errors` sind keine Betriebsoptionen.

## Diagnose

```sh
systemctl status screenable-api avahi-daemon getty@tty1
journalctl -u screenable-api -b --no-pager -n 100
journalctl _UID="$(id -u screenable)" -b --no-pager -n 150
journalctl -p warning -b --no-pager          # nur Warnungen und Fehler
sudo -u screenable DISPLAY=:0 xrandr --query
cat /run/screenable-player/status.json
cat /opt/screenable-player/current/RELEASE
```

Logs sind strukturiertes JSON mit journald-Priorität und bleiben über Neustarts erhalten (höchstens 500 MB bzw. einen Monat). Wiederkehrende Fehler werden nur bei Änderung protokolliert. Inhalts-URLs und Passwörter erscheinen nicht im Log.

`/api/v1/health` meldet nur die API-Laufzeit. Der angemeldete Status zeigt Version, Zertifikatslaufzeit und den Player-Zustand; ein mehr als zehn Sekunden altes Statusdokument wird als `offline` markiert. „Inhalteserver erreichbar“ bedeutet, dass eine TCP-Verbindung zum Host der Inhalts-URL gelingt; hinter einem HTTP-Proxy ist dieser Wert nicht aussagekräftig. Ein lebender Chromium-Prozess beweist noch keine korrekte WebGL- oder Audio-Ausgabe.
