# Screenable Player

Schlanker Single-Screen-Player für den Giada D613: Debian 13, X11/Openbox, Chromium und ein lokales Dashboard. Dieses Repository setzt zunächst den MVP für **einen** HDMI-Ausgang um.

## Installation auf Debian 13

Ein Skript richtet ein frisch installiertes Debian 13 vollständig ein. Es arbeitet zwölf Schritte nacheinander ab: Pakete, Anwendung, Benutzer, Firewall, LTE, WLAN-Hotspot, Passwort, Zertifikat, Updates und Start. Jeder Schritt prüft zuerst, ob er schon erledigt ist. Bricht etwas ab, Ursache beheben und das Skript erneut starten.

Direkt von GitHub, mit dem neuesten Release:

```sh
curl -fsSL https://raw.githubusercontent.com/screenable/SignagePlayer/main/install.sh | sudo bash
```

Das Skript lädt das fertig gebaute Paket des Releases, prüft dessen SHA-256-Prüfsumme und installiert es; auf dem Gerät ist kein npm nötig. Eine bestimmte Version: `… | sudo SCREENABLE_VERSION=v0.3.0 bash`. Solange das Repository privat ist, braucht der Download ein Lese-Token (siehe [Betrieb](docs/operations.md#installation-von-github)).

Alternativ aus einem entpackten Installationspaket (`npm run package`) oder Git-Checkout: `sudo ./install.sh`. Im Checkout baut das Skript bei Bedarf selbst (als aufrufender Benutzer, installiert dafür npm).

Das Skript fragt nur, was noch fehlt: Dashboard-Passwort, WLAN-Passwort für einen neuen Hotspot und gegebenenfalls die SIM-PIN. Vorhandene Netzwerkprofile bleiben unverändert; nur die Hotspot-Adresse wird fest eingetragen. Danach im Hotspot `https://10.42.0.1:8443` oder `https://<hostname>.local:8443` öffnen, dem lokalen Zertifikat vertrauen und eine HTTPS-Inhalts-URL speichern. Nach der Erstinstallation das Gerät neu starten (das Skript bietet es an). Über LTE nimmt das Gerät keine Verbindungen an.

Updates laufen genauso: denselben Befehl erneut ausführen. Ein neues Release wird erst nach erfolgreichem Health-Check aktiv, sonst automatisch zurückgerollt. Optionen und Betrieb: [Betrieb](docs/operations.md), alle Optionen auch mit `./install.sh --help`.

**Voraussetzung:** Debian 13 amd64 am D613 mit funktionierendem lokalen X11-Start. Die Hardwarekompatibilität, HDMI-Audio, GPU-Beschleunigung und Eingaben sind noch am echten Gerät abzunehmen. Siehe [Hardwaretest](docs/hardware-test-d613.md).

## Lokal entwickeln

```sh
npm ci
npm run build
SCREENABLE_STATE_DIR="$PWD/state" SCREENABLE_RUN_DIR="$PWD/state/run" npm run setup
SCREENABLE_STATE_DIR="$PWD/state" SCREENABLE_RUN_DIR="$PWD/state/run" npm run start:api
```

Das Dashboard läuft dann auf `http://127.0.0.1:8080`. Der Player benötigt Linux/X11, `xrandr`, `xdotool` und Chromium. In einer X11-Session mit denselben Verzeichnissen `npm run start:player` ausführen. `npm run dev:web` startet alternativ Vite auf einem Entwicklungsport mit Proxy zur lokalen API; `npm run dev:api` startet die API mit automatischem Neustart, wenn parallel `npx tsc -p tsconfig.json -w` läuft.

## Container für Dashboard-Demo

```sh
docker compose build
docker compose run --rm dashboard node dist/cli.js init
docker compose up -d
```

Auf `http://127.0.0.1:8080` ist das Dashboard lokal erreichbar. Das Image wird vollständig im Container gebaut und getestet und läuft schreibgeschützt ohne Capabilities. Dieser Container betreibt **keinen** Chromium-Player: Für den D613 übernimmt der native Dienst X11, GPU, Gamepad und Audio ohne zusätzliche Geräte-Mounts oder Container-Privilegien. Der Container eignet sich zum Prüfen der Oberfläche und API; der Playerstatus bleibt dort unbekannt. Die Geräteeinrichtung erfolgt mit dem Debian-Installer oben.

## Funktionen

- Anmeldung mit scrypt-Passworthash, Session-Cookie, CSRF-Token und begrenzten Login-Versuchen; Passwortwechsel per `cli.js passwd` meldet alle Sitzungen ab.
- HTTPS-Inhalts-URL, wählbarer HDMI-Ausgang, validierte Version-1-Konfiguration mit Revision und Backup.
- Chromium-Kiosk mit Sandbox, eigenem Profil, Autoplay-Flag, Fokusversuch und begrenztem Neustart-Backoff; kein „Seiten wiederherstellen“-Hinweis nach Stromausfall.
- Anzeige wird nie abgeschaltet (kein Bildschirmschoner/DPMS); nach dem Ein- und Ausschalten eines Monitors setzt der Player das Layout neu.
- Kiosk-Absicherung für öffentlich zugängliche Tastaturen: Openbox ohne Menüs und Tastenkürzel, Chromium-Richtlinien gegen Entwicklertools, Downloads, Dateidialoge und interne Seiten, optional gesperrter Konsolenwechsel.
- Status und Aktionen über `/api/v1`; lokale Hardware-Testseite unter `/diagnostic.html`.
- API separat vom X11-Player, sodass das Dashboard bei einem Browserabsturz erreichbar bleibt; gehärteter systemd-Dienst.
- Firewall: Dashboard, SSH und mDNS nur aus dem Hotspot erreichbar, nicht über LTE (IPv4/IPv6); feste Hotspot-Adresse und Gerätename auch für Android-Clients auflösbar.
- Versionierte Releases mit automatischem Rollback, Zertifikatserneuerung ohne Neustart, begrenzte persistente Logs.

**Noch nicht umgesetzt:** Span/Independent, Audio-Sink-Auswahl, Debugging und sichere Offline-Inhaltsanzeige. Diese Bereiche sind für eine spätere Version geplant oder benötigen Messungen am Gerät.

## Prüfung und Betrieb

`npm run build && npm test` prüft Konfiguration, Authentifizierung, API und Player-Steuerung (mit simuliertem `xrandr`/Chromium). Die CI führt das zusätzlich unter Node 20 (Debian 13) und Node 22 aus und prüft Skripte und Systemdateien. Auf dem D613 die [Testschritte](docs/hardware-test-d613.md) ausführen. Für Installation, Updates, Zertifikat und Logs siehe [Betrieb](docs/operations.md).
