# Installation und Betrieb

## Installation

`install.sh` (im Installationspaket bzw. im Repository-Stamm) richtet das Gerät in zwölf Schritten ein und ist beliebig oft ausführbar:

| Schritt | Wenn schon erledigt |
|---|---|
| 1. Voraussetzungen (Debian 13, Optionen) | – |
| 2. Systempakete (Xorg, Openbox, Chromium, Node.js, NetworkManager, ModemManager, nftables, Avahi) | apt installiert nur Fehlendes |
| 3. Anwendung bauen (nur im Git-Checkout, als aufrufender Benutzer) | übersprungen, wenn der Build aktuell ist |
| 4. Benutzer und Verzeichnisse | unverändert |
| 5. Release vorbereiten | gleicher Inhalt → kein neues Release |
| 6. Firewall | Regeln werden ohne Lücke neu geladen |
| 7. Mobilfunk: LTE-Profil anlegen, falls keins existiert und ein Modem erkannt wird | vorhandenes Profil bleibt unverändert |
| 8. WLAN-Hotspot anlegen und starten, Gerätename im Hotspot | vorhandenes Profil bleibt; nur fehlende feste Adresse wird ergänzt |
| 9. Administratorpasswort | vorhandenes bleibt |
| 10. TLS-Zertifikat | bleibt, solange es zu Name und Hotspot-Adresse passt und mehr als 30 Tage gilt; ein selbstsigniertes wird sonst erneuert |
| 11. Automatische Sicherheitsupdates | Konfiguration wird neu geschrieben |
| 12. Anwendung aktivieren mit Health-Check und Rollback | antwortet das Dashboard nicht, wird das aktive Release neu aktiviert |

Bei einem Abbruch nennt das Skript den Schritt; das vollständige Protokoll steht in `/var/log/screenable-player-install.log` (ohne Passwörter). Ursache beheben und erneut starten.

### Optionen

Optionen werden als Umgebungsvariablen übergeben und in `/etc/screenable-player/install.env` gespeichert, damit Updates und Rollbacks dieselben Einstellungen verwenden. Beim Aufruf gesetzte Werte haben Vorrang vor den gespeicherten. Beispiel: `sudo SCREENABLE_REBOOT_TIME=05:30 ./install.sh`

| Variable | Standard | Wirkung |
|---|---|---|
| `SCREENABLE_HOTSPOT_CONNECTION` | `Giada-Hotspot` | NetworkManager-Profil des Hotspots |
| `SCREENABLE_HOTSPOT_SSID` | `Giada-WIFI` | WLAN-Name, nur beim Anlegen des Profils |
| `SCREENABLE_HOTSPOT_ADDRESS` | `10.42.0.1` | Feste Adresse des Geräts im Hotspot |
| `SCREENABLE_ADMIN_INTERFACES` | WLAN-Gerät des Hotspots | Schnittstellen mit Verwaltungszugang, durch Leerzeichen getrennt |
| `SCREENABLE_FIREWALL` | `1` | Eingehende Verbindungen nur über die Verwaltungsschnittstellen |
| `SCREENABLE_LTE` | `auto` | LTE-Profil anlegen: `auto`/`1` immer (verbindet, sobald ein Modem erscheint), `0` nie |
| `SCREENABLE_LTE_CONNECTION` | `Telekom-LTE` | NetworkManager-Profil für LTE |
| `SCREENABLE_LTE_APN` | `internet.telekom` | APN, nur beim Anlegen des Profils |
| `SCREENABLE_LTE_DNS` | `1.1.1.1 8.8.8.8` | IPv4-DNS-Server, nur beim Anlegen des Profils |
| `SCREENABLE_KIOSK_LOCKDOWN` | `1` | Sperrt Konsolenwechsel (Strg+Alt+F1–F12) und Magic-SysRq für Geräte mit öffentlich zugänglicher Tastatur |
| `SCREENABLE_UNATTENDED_UPGRADES` | `1` | Spielt Debian-Sicherheitsupdates (inkl. Chromium) automatisch ein |
| `SCREENABLE_REBOOT_TIME` | `04:00` | Uhrzeit für Neustarts, die ein Update erfordert |
| `SCREENABLE_KEEP_RELEASES` | `3` | Anzahl aufbewahrter Releases für Rollbacks |

### Ohne Rückfragen (viele Geräte)

Passwörter, die noch fehlen, fragt das Skript am Terminal ab. Für eine automatisierte Einrichtung lassen sie sich übergeben; sie werden nirgends gespeichert oder protokolliert:

```sh
sudo SCREENABLE_ADMIN_PASSWORD='…' SCREENABLE_HOTSPOT_PSK='…' SCREENABLE_SIM_PIN= ./install.sh < /dev/null
```

`SCREENABLE_SIM_PIN=` (leer) bedeutet: SIM ohne PIN, nicht nachfragen. Der Hotspot verwendet WPA2 mit CCMP. Neue Profile legt das Skript als NetworkManager-Keyfiles (Rechte 0600) an, damit Passwörter nicht in Prozesslisten erscheinen.

## Installation von GitHub

`install.sh` kann allein per `curl` gestartet werden. Es lädt dann aus den GitHub-Releases das Paket `screenable-player.tar.gz` und `SHA256SUMS`, prüft die Prüfsumme, entpackt in ein temporäres Verzeichnis und startet das darin enthaltene `install.sh`. Rückfragen kommen auch bei `curl | sudo bash` vom Terminal.

```sh
# neuestes Release
curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo bash
# bestimmte Version, zusätzliche Optionen
curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo SCREENABLE_VERSION=v0.6.0 SCREENABLE_REBOOT_TIME=05:30 bash
```

Auf einem minimalen Debian ohne `curl` vorher `sudo apt install -y curl` ausführen. Die Prüfsumme schützt vor beschädigten oder abgebrochenen Downloads; die Echtheit hängt am Zugang zum GitHub-Repository.

**Privates Repository:** GitHub liefert Dateien privater Repositories nur mit Token aus. Dafür ein Fine-grained Personal Access Token anlegen (GitHub → Settings → Developer settings → Fine-grained tokens): nur Repository `screenable/SignagePlayer`, Berechtigung *Contents: Read-only*. Das Token beim Aufruf abfragen statt es in die Shell-Historie zu schreiben:

```sh
read -rsp 'GitHub-Token: ' T; echo
curl -fsSL -H "Authorization: Bearer $T" https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh \
  | sudo SCREENABLE_GITHUB_TOKEN="$T" bash
unset T
```

Das Token wird nicht protokolliert. Damit das Dashboard später Updates laden kann, speichert der Installer es in `/etc/screenable-player/github-token` (root, `0600`); weder API noch Player können es lesen. Ein Token mit langer Laufzeit wählen und bei Bedarf durch einen erneuten Aufruf mit neuem Token ersetzen. Wird die Datei gelöscht, kann das Dashboard aus einem privaten Repository keine Updates mehr laden.

### Release veröffentlichen

Releases entstehen automatisch: Bei jedem Merge auf `main` prüft `.github/workflows/release.yml`, ob es für die Version in `package.json` schon ein Release gibt. Wenn nicht, baut und testet er unter Node 20 (wie Debian 13), legt das Tag `v<version>` an und veröffentlicht `screenable-player.tar.gz` (fester Name für „neuestes Release“), `screenable-player-<version>.tar.gz` und `SHA256SUMS`. Ab dann installiert der `curl`-Befehl diese Version. Ein Merge ohne Versionsänderung veröffentlicht nichts.

Für ein neues Release also im Pull Request die Version erhöhen:

```sh
npm version 0.3.1 --no-git-tag-version   # ändert package.json und package-lock.json
```

Ein Tag muss niemand von Hand setzen. Schlägt ein Release-Lauf fehl, lässt er sich unter *Actions → Release → Run workflow* auf `main` erneut starten.

## Netzwerkzugang

Das Gerät geht über LTE ins Internet und spannt einen eigenen WLAN-Hotspot auf. Verwaltet wird es **nur aus dem Hotspot**: Dashboard, SSH und mDNS sind ausschließlich dort erreichbar. Über LTE (IPv4 und die öffentliche IPv6-Adresse) nimmt das Gerät keine Verbindungen an; eine Fernwartung über LTE ist nicht vorgesehen.

Im Hotspot ist das Dashboard erreichbar unter:

- `https://10.42.0.1:8443` – feste Adresse, im NetworkManager-Profil eingetragen
- `https://<hostname>.local:8443` – per mDNS (Avahi) und zusätzlich über den DNS des Hotspots, weil Android `.local`-Namen oft nicht per mDNS auflöst

`install.sh` setzt das in den Schritten 6 bis 8 um:

| Baustein | Wirkung |
|---|---|
| `screenable-firewall.service` | Lädt `/etc/screenable-player/firewall.nft` vor dem Netzwerkstart. Eingehend nur Loopback, Antworten auf eigene Verbindungen und die Hotspot-Schnittstelle; für LTE nur IPv6-Router-Advertisements und Neighbor Discovery. Von Docker veröffentlichte Ports sind nur aus dem Hotspot und von lokalen Containern erreichbar. |
| NetworkManager-Profil | `ipv4.addresses 10.42.0.1/24` im Hotspot-Profil, falls dort noch keine Adresse steht |
| `/etc/NetworkManager/dnsmasq-shared.d/screenable.conf` | Hotspot-DNS beantwortet `<hostname>.local` und `<hostname>` mit der Hotspot-Adresse |
| `/etc/avahi/avahi-daemon.conf` | `allow-interfaces=` auf die Hotspot-Schnittstelle |

Die Firewall nutzt eine eigene nftables-Tabelle (`inet screenable`) und ersetzt keine Regeln von NetworkManager (Hotspot-NAT, DHCP, DNS) oder Docker; `nftables.service` bleibt deaktiviert. Hotspot-Clients kommen weiterhin über LTE ins Internet. Änderungen an einem bestehenden Hotspot-Profil wirken ab der nächsten Aktivierung des Hotspots, spätestens nach einem Neustart; ein laufender Hotspot wird während der Installation nicht unterbrochen.

Wird das Installationsskript per SSH über eine andere Schnittstelle ausgeführt, bleibt diese Sitzung bestehen, neue Verbindungen dorthin sind danach gesperrt. Für Ethernet als zusätzlichen Verwaltungszugang `SCREENABLE_ADMIN_INTERFACES="wlp2s0 eno1"` setzen; zum Abschalten `SCREENABLE_FIREWALL=0`. Den Zustand prüfen mit `sudo nft list table inet screenable`.

### Mobilfunk prüfen

Das LTE-Profil verbindet beim Booten und nach Netzverlust automatisch und unbegrenzt oft neu. Zusätzlich prüft `screenable-lte-watchdog.timer` alle zwei Minuten per Ping (1.1.1.1, 8.8.8.8, Cloudflare-IPv6), ob über LTE wirklich Daten fließen. Manche Modems melden nach dem Booten eine aktive Verbindung, übertragen aber nichts (`tx: 0 bytes, rx: 0 bytes` im ModemManager-Journal). Nach drei Fehlschlägen in Folge baut der Watchdog die Verbindung neu auf. Protokoll: `journalctl -u screenable-lte-watchdog`.


Der Installer legt das LTE-Profil immer an, wartet bei der Ersteinrichtung bis zu 60 s auf das Modem, prüft danach die LTE-Verbindung und gibt bei einem Fehler den Modemzustand aus. Am Gerät:

```sh
nmcli device status                      # gsm-Gerät: "verbunden"?
nmcli radio wwan                         # muss "enabled" sein, sonst: sudo nmcli radio wwan on
mmcli -L && mmcli -m any                 # State, Failed reason, SIM, Signal, Operator
nmcli -g gsm.apn connection show Telekom-LTE
journalctl -u ModemManager -u NetworkManager -b | grep -iE 'modem|gsm|bearer' | tail -n 40
```

| Befund in `mmcli -m any` | Ursache und Abhilfe |
|---|---|
| keine Modemliste | Modul nicht erkannt: BIOS (WWAN aktiviert?), `rfkill list`, `lsusb` |
| `state: locked`, `lock: sim-pin` | PIN fehlt oder falsch, Profil neu anlegen (siehe unten) |
| `failed reason: sim-missing` | SIM nicht gesteckt oder falsch eingelegt |
| `power state: low`, `state: disabled` und `FCC lock` im Journal | FCC-Sperre des Moduls: `sudo ln -s /usr/share/ModemManager/fcc-unlock.available.d/<vid:pid> /etc/ModemManager/fcc-unlock.d/` |
| `registered`, `attached`, aber `nmcli device status` zeigt `gsm … nicht verbunden --` | kein LTE-Profil vorhanden (ältere Installer übersprangen es, wenn das Modem noch nicht erkannt war): Installer erneut ausführen |
| `registered`, aber kein Bearer/IP | falscher APN: die Vorgabe `internet.telekom` passt nur für Telekom-SIMs |
| `signal quality` sehr niedrig, `searching` | Antennen prüfen |

Das Dashboard zeigt unter „LTE“ den Modemzustand, Netzbetreiber, Funktechnik und die Signalqualität in fünf Balken (je angefangene 20 % von ModemManagers `signal quality` ein Balken; ohne Netz null Balken). Die API fragt dafür höchstens alle 10 s `mmcli -m any --output-json` ab; ModemManager erlaubt dieses Lesen ohne Root-Rechte.

Ein vorhandenes LTE-Profil ändert der Installer nicht. Für andere PIN oder APN das Profil löschen und neu anlegen lassen, z. B. für Vodafone:

```sh
sudo nmcli connection delete Telekom-LTE
curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo SCREENABLE_LTE_APN=web.vodafone.de bash
```

Gängige APNs: Telekom `internet.telekom`, Vodafone `web.vodafone.de`, O2 `internet`, 1&1 `web.vodafone.de` oder `internet` (je nach Netz).

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
| `screenable-update.path`, `screenable-update.service` | Over-the-Air-Update aus dem Dashboard (root, siehe [Updates aus dem Dashboard](#updates-aus-dem-dashboard)) |
| `/etc/screenable-player/github-token` | optionales Lese-Token für private Repositories, nur für root lesbar |

Nach einem Kaltstart meldet sich `screenable` auf `tty1` automatisch an, startet Xorg/Openbox und darin den Player-User-Dienst. Ein zweiter Display-Manager oder eine bereits belegte `tty1` muss zuvor entfernt bzw. angepasst werden.

## Kiosk-Absicherung

Für Geräte mit Tastatur oder Gamepad im öffentlichen Bereich:

- **Openbox** startet mit `openbox/rc.xml` aus dem Release: kein Desktop-Menü (dort läge sonst „Terminal“), keine Tastenkürzel, keine Arbeitsflächen. Der Mauszeiger wird nach drei Sekunden ohne Bewegung ausgeblendet (`unclutter-xfixes`).
- **Chromium-Richtlinien** sperren Entwicklertools, Downloads, Drucken, Dateidialoge, Inkognito-/Gastfenster, Erweiterungen sowie `file://`- und `chrome://`-Seiten (außer `chrome://gpu` für den Hardwaretest). Benachrichtigungen und Standortabfragen werden abgelehnt; Kamera und Mikrofon fragen weiterhin nach. Für Inhalte, die Kamera oder Mikrofon brauchen, `VideoCaptureAllowedUrls`/`AudioCaptureAllowedUrls` in der Richtliniendatei ergänzen.
- **Lockdown** (`SCREENABLE_KIOSK_LOCKDOWN=1`): kein Wechsel auf Textkonsolen, Magic-SysRq aus. Für Wartung am Gerät mit `SCREENABLE_KIOSK_LOCKDOWN=0` neu installieren und neu starten; SSH ist nicht betroffen.

Chromium-eigene Kürzel zum Schließen (Strg+W, Strg+Umschalt+Q) lassen sich nicht per Richtlinie sperren. Der Player startet den Browser dann nach der eingestellten Verzögerung neu.

## Updates und Rollback

### Updates aus dem Dashboard

Die Karte „Software-Update“ zeigt die installierte Version. **Nach Updates suchen** fragt das neueste GitHub-Release ab und zeigt dessen Version, Datum und Änderungen; ist es neuer, spielt **Update installieren** es ein. Während der Installation zeigt die Karte die letzten Zeilen der Installerausgabe. Player und Dashboard starten dabei neu; die Anzeige ist kurz unterbrochen und alle Dashboard-Sitzungen enden. Danach erneut anmelden.

Ablauf: Die API läuft ohne Rechte und kann selbst nichts installieren. Sie schreibt nur die Aktion (`check` oder `install`) nach `/run/screenable-player/update-request.json`. `screenable-update.path` startet daraufhin `screenable-update.service` als root, der das neueste Release von `screenable/SignagePlayer` abfragt und `install.sh --download` mit genau dieser Version ausführt – derselbe Weg wie beim Aufruf per `curl`: Download, SHA-256-Prüfung, neues Release, Health-Check und bei einem Fehler automatischer Rollback. Versionen, URLs oder Optionen aus der Anforderung werden nicht angenommen; ein älteres oder gleiches Release wird nie installiert. Fortschritt und Ergebnis stehen in `/run/screenable-player/update.json`, das vollständige Protokoll in `/var/log/screenable-player-install.log`.

Für ein privates Repository muss bei der Installation einmal `SCREENABLE_GITHUB_TOKEN` gesetzt worden sein (siehe [Installation von GitHub](#installation-von-github)); sonst meldet die Suche „Kein Release gefunden“. Der Download läuft über LTE: Ein Update umfasst das Paket (wenige MB) und gegebenenfalls Debian-Pakete aus `apt-get`.

Geräte mit Version 0.4 oder älter haben den Update-Dienst noch nicht: einmal von Hand auf 0.5 aktualisieren (siehe unten), danach geht es über das Dashboard.

```sh
systemctl status screenable-update.path screenable-update.service
journalctl -u screenable-update -b --no-pager -n 100
cat /run/screenable-player/update.json
```

### Updates von Hand

Neue Version auf einem Testgerät prüfen, dann auf dem Gerät denselben Befehl wie bei der Installation ausführen (oder ein Installationspaket entpacken und `sudo ./install.sh`):

```sh
curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo bash
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

## Tonausgabe (HDMI)

Die Kiosk-Sitzung nutzt PipeWire (`pipewire-pulse`, WirePlumber). Der Player prüft alle 10 s, welcher HDMI-Port ein audiofähiges Gerät meldet – nach dem `xrandr`-Layout ist das nur der gewählte Ausgang –, schaltet bei Bedarf das Kartenprofil um, setzt ihn als Standardgerät auf 100 % und hebt die Stummschaltung auf. Das Dashboard zeigt das Gerät unter „Tonausgabe“; ohne Gerät steht „Kein HDMI-Ton“ (Monitor ohne Lautsprecher, getrennt oder Ton am Monitor deaktiviert).

Prüfen am Gerät:

```sh
sudo -u screenable XDG_RUNTIME_DIR=/run/user/$(id -u screenable) wpctl status
sudo -u screenable XDG_RUNTIME_DIR=/run/user/$(id -u screenable) pactl list cards short
journalctl _UID=$(id -u screenable) | grep audio_
aplay -l   # erscheint keine Karte: firmware-sof-signed installieren und neu starten
```

Automatische Umschaltung abschalten (z. B. für Klinke): `systemctl --user -M screenable@ edit screenable-player` mit `Environment=SCREENABLE_AUDIO_ROUTING=0`.

Die Lautstärke stellt der Regler „Lautstärke“ im Dashboard ein (0–100 %, 0 = stumm; Standard 100 %). Der Player setzt sie sofort und bei jeder Prüfung erneut, auch wenn sie am Gerät verstellt wurde. Der Browser startet dafür nicht neu. Gespeichert wird sie in `config.json` unter `volume`.

## Startbildschirm und Netzverbindung

Chromium startet erst, wenn der Server der Inhalts-URL per TCP erreichbar ist; so erscheint nach dem Einschalten nie eine Chromium-Fehlerseite, nur weil LTE noch nicht verbunden ist. Bis dahin zeigt der Bildschirm das Screenable-Logo (`splash/` im Release, je nach Ausrichtung Quer- oder Hochformat) als Desktop-Hintergrund; der Player-Status lautet „Wartet auf Internet“ und die Prüfung läuft alle zwei Sekunden. Der Hintergrund bleibt auch während eines Browser-Neustarts sichtbar. Fällt das Netz bei laufendem Browser aus, läuft dieser weiter und lädt die Seite nach der Rückkehr neu.

Das gilt für jeden Browserstart, auch nach einem Absturz. Für Inhalte, die ohne Netz funktionieren, lässt sich das Warten abschalten: `systemctl --user -M screenable@ edit screenable-player` mit `Environment=SCREENABLE_WAIT_FOR_NETWORK=0`. Den Hintergrund setzt `feh`; fehlt es, bleibt der Bildschirm weiß.

## Anwendungen auswählen

Das Feld „Screenable-URL“ durchsucht beim Tippen die Screenable-Anwendungen (Name, Beschreibung und Adresse) und schlägt bis zu acht Treffer vor; Pfeiltasten und Enter wählen aus. Eine eigene HTTPS-Adresse kann weiterhin direkt eingegeben werden. Die Liste lädt die API von `https://screenable.app/lister2` (JSON oder HTML-Links, nur HTTPS-Adressen) und hält sie 15 Minuten vor; „Liste aktualisieren“ lädt sie sofort neu. Ohne Internet bleibt die zuletzt geladene Liste nutzbar. Eine andere Quelle per Drop-in für `screenable-api.service`: `Environment=SCREENABLE_APPS_URL=…`.

## Bildausrichtung

Im Dashboard lässt sich je HDMI-Ausgang die Ausrichtung wählen; sie gilt, sobald dieser Ausgang aktiv ist, auch bei „Automatisch“:

| Auswahl | `xrandr --rotate` | Montage des Bildschirms |
|---|---|---|
| Querformat | `normal` | normal |
| Querformat, 180° gedreht | `inverted` | auf dem Kopf (z. B. Deckenhalterung) |
| Hochformat, Bild 90° nach links gedreht | `left` | hochkant, im Uhrzeigersinn gedreht (die Oberkante des Monitors zeigt nach rechts) |
| Hochformat, Bild 90° nach rechts gedreht | `right` | hochkant, gegen den Uhrzeigersinn gedreht (die Oberkante zeigt nach links) |

Steht das Bild nach dem Speichern auf dem Kopf, die andere Hochformat-Richtung wählen. Der Player setzt die Drehung beim Browserstart und nach einem Monitor-Hotplug erneut; Chromium erhält dadurch die hochkant gestellte Auflösung (z. B. 1080×1920). Gespeichert wird sie in `config.json` unter `orientations`, nur für Ausgänge, die nicht im Querformat laufen.

## Auflösung

Neben der Ausrichtung lässt sich je HDMI-Ausgang die Auflösung wählen: „Automatisch“ (bevorzugter Modus des Bildschirms), 720p (1280×720), 1080p (1920×1080) oder 4K (3840×2160). Der Player setzt sie beim Browserstart und nach einem Monitor-Hotplug per `xrandr --mode`. Auflösungen, die der angeschlossene Bildschirm nicht anbietet, sind im Dashboard gesperrt; ist eine gespeicherte Auflösung nicht verfügbar (z. B. nach einem Bildschirmtausch), fällt der Player auf den bevorzugten Modus zurück und meldet `resolution_unavailable` im Journal. Bei Drehung ins Hochformat erhält Chromium die gedrehte Auflösung (z. B. 2160×3840). Gespeichert wird sie in `config.json` unter `resolutions`, nur für Ausgänge mit fester Auflösung.

## Diagnose

```sh
systemctl status screenable-api avahi-daemon getty@tty1
journalctl -u screenable-api -b --no-pager -n 100
journalctl _UID="$(id -u screenable)" -b --no-pager -n 150
journalctl -p warning -b --no-pager          # nur Warnungen und Fehler
sudo -u screenable DISPLAY=:0 xrandr --query
cat /run/screenable-player/status.json
mmcli -m any                                  # LTE-Signal wie im Dashboard
cat /opt/screenable-player/current/RELEASE
```

Logs sind strukturiertes JSON mit journald-Priorität und bleiben über Neustarts erhalten (höchstens 500 MB bzw. einen Monat). Wiederkehrende Fehler werden nur bei Änderung protokolliert. Inhalts-URLs und Passwörter erscheinen nicht im Log.

`/api/v1/health` meldet nur die API-Laufzeit. Der angemeldete Status zeigt Version, Zertifikatslaufzeit und den Player-Zustand; ein mehr als zehn Sekunden altes Statusdokument wird als `offline` markiert. „Inhalteserver erreichbar“ bedeutet, dass eine TCP-Verbindung zum Host der Inhalts-URL gelingt; hinter einem HTTP-Proxy ist dieser Wert nicht aussagekräftig. Ein lebender Chromium-Prozess beweist noch keine korrekte WebGL- oder Audio-Ausgabe.
