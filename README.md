# Screenable Player

Schlanker Single-Screen-Prototyp für den Giada D613: Debian 13, X11/Openbox, Chromium und ein lokales Dashboard. Dieses Repository setzt zunächst den MVP für **einen** HDMI-Ausgang um.

## Schnellstart auf Debian 13

Auf einem frisch installierten Gerät ohne anderen Display-Manager:

```sh
npm ci
npm run build
sudo bash scripts/install-debian13.sh
sudo reboot
```

Der Installer richtet getrennte Benutzer `screenable-api` und `screenable`, eine automatische Anmeldung auf `tty1`, Xorg/Openbox, systemd-Dienste, Avahi und ein selbstsigniertes TLS-Zertifikat ein. Er fragt beim ersten Lauf nach einem Administratorpasswort. Danach im LAN `https://<hostname>.local:8443` öffnen, dem lokalen Zertifikat auf dem Verwaltungsgerät vertrauen und eine HTTPS-Inhalts-URL speichern. Ohne konfigurierte URL bleibt der Player im Wartezustand.

**Voraussetzung:** Debian 13 amd64 am D613 mit funktionierendem lokalen X11-Start. Die Hardwarekompatibilität, HDMI-Audio, GPU-Beschleunigung und Eingaben sind noch am echten Gerät abzunehmen. Siehe [Hardwaretest](docs/hardware-test-d613.md).

## Lokal entwickeln

```sh
npm ci
npm run build
SCREENABLE_STATE_DIR="$PWD/state" SCREENABLE_RUN_DIR="$PWD/state/run" npm run setup
SCREENABLE_STATE_DIR="$PWD/state" SCREENABLE_RUN_DIR="$PWD/state/run" npm run start:api
```

Das Dashboard läuft dann auf `http://127.0.0.1:8080`. Der Player benötigt Linux/X11, `xrandr`, `xdotool` und Chromium. In einer X11-Session mit denselben Verzeichnissen `npm run start:player` ausführen. `npm run dev:web` startet alternativ Vite auf einem Entwicklungsport mit Proxy zur lokalen API.

## Container für Dashboard-Demo

```sh
npm ci && npm run build
docker compose run --rm dashboard node dist/cli.js init
docker compose up -d
```

Auf `http://127.0.0.1:8080` ist das Dashboard lokal erreichbar. Dieser Container betreibt **keinen** Chromium-Player: Für den D613 übernimmt der native Dienst X11, GPU, Gamepad und Audio ohne zusätzliche Geräte-Mounts oder Container-Privilegien. Der Container eignet sich zum Prüfen der Oberfläche und API; der Playerstatus bleibt dort unbekannt. Die Geräteeinrichtung erfolgt mit dem Debian-Installer oben.

## Funktionen des Prototyps

- Anmeldung mit scrypt-Passworthash, Session-Cookie, CSRF-Token und begrenzten Login-Versuchen.
- HTTPS-Inhalts-URL, wählbarer HDMI-Ausgang, validierte Version-1-Konfiguration mit Revision und Backup.
- Chromium-Kiosk mit Sandbox, eigenem Profil, Autoplay-Flag, Fokusversuch und begrenztem Neustart-Backoff.
- Status und Aktionen über `/api/v1`; lokale Hardware-Testseite unter `/diagnostic.html`.
- API separat vom X11-Player, sodass das Dashboard bei einem Browserabsturz erreichbar bleibt.

**Noch nicht umgesetzt:** Span/Independent, Audio-Sink-Auswahl, Update/Rollback, Debugging und sichere Offline-Inhaltsanzeige. Diese Bereiche sind für eine spätere Version geplant oder benötigen Messungen am Gerät.

## Prüfung und Betrieb

`npm run build && npm test` prüft Konfigurations- und Authentifizierungslogik sowie die API. Auf dem D613 die [Testschritte](docs/hardware-test-d613.md) ausführen. Für Installation, Zertifikat und Logs siehe [Betrieb](docs/operations.md).
