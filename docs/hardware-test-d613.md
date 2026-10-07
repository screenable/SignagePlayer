# D613-Hardwaretest

**Stand 5. Oktober 2026: kein D613 in dieser Entwicklungsumgebung vorhanden. Alle folgenden Hardware-Ergebnisse sind offen.** Das Protokoll wird direkt am Gerät ausgefüllt; API-Unit-Tests ersetzen diese Prüfung nicht.

## Gerätebasis erfassen

```sh
cat /etc/os-release
uname -a
lspci -nnk | sed -n '/VGA\|Display/,+4p'
DISPLAY=:0 xrandr --query
wpctl status
ls /dev/input/js* /dev/input/event* 2>/dev/null
```

Gerätevariante, BIOS-Version, RAM/SSD, angeschlossene HDMI-Ports, Auflösungen, Intel-Treiber und Audio-Sinks im Testprotokoll notieren. `chrome://gpu` im Kiosk beziehungsweise in einer separaten Chromium-Sitzung öffnen und GPU-Status dokumentieren.

## Funktionstest

Auf dem D613 `node /opt/screenable-player/current/scripts/diagnostic-server.mjs` starten und im Dashboard als Inhalt `http://localhost:8090/diagnostic.html` setzen. Die Testseite zeigt WebGL, Tastatur- und Gamepad-Ereignisse sowie das Ergebnis von WebAudio-, HTML-Audio- und Video-Autoplay. Lautsprecher an HDMI und Klinke einzeln anschließen; die API-Erfolgsmeldung allein zählt nicht als hörbarer Ton. Für jede Prüfung **Bestanden / Fehlgeschlagen / Nicht getestet**, Foto oder Log und Datum erfassen. Nach dem Test den Diagnose-Server beenden und die produktive URL wiederherstellen.

| Prüfung | Vorgehen | Ergebnis |
|---|---|---|
| Kaltstart | Strom trennen, booten, konfigurierte Seite ohne Eingriff sichtbar | Nicht getestet |
| Tastatur | Eine Taste drücken; Anzeige auf Testseite prüfen | Nicht getestet |
| Gamepad | Taste drücken; Anzeige auf Testseite prüfen | Nicht getestet |
| WebGL/GPU | Grünes Canvas und `chrome://gpu` prüfen | Nicht getestet |
| WebAudio | 440-Hz-Ton nach Seitenaufruf hören | Nicht getestet |
| HTML-Audio | 660-Hz-Ton nach Seitenaufruf hören | Nicht getestet |
| Video-Autoplay | Testvideo meldet `play() erfolgreich` | Nicht getestet |
| HDMI-Audio | Ton über jeden vorgesehenen HDMI-Port hören | Nicht getestet |
| Klinke-Audio | Ton über Klinke hören | Nicht getestet |
| Browser-Kill | PID aus Dashboard mit `kill -9 <PID>` beenden; Recoveryzeit messen | Nicht getestet |
| Netzwerkverlust | LTE-Antenne abziehen bzw. Funkloch simulieren, wieder anschließen; Fehler und Erholung prüfen | Nicht getestet |
| Display-Auswahl | Jeden realen HDMI-Ausgang einzeln im Dashboard wählen | Nicht getestet |
| Dauerbetrieb Anzeige | Gerät 30 Minuten ohne Eingabe laufen lassen; Bild darf nicht schwarz werden | Nicht getestet |
| Monitor-Hotplug | Monitor/TV aus- und wieder einschalten bzw. HDMI-Kabel ziehen; Bild kommt ohne Bedienung zurück | Nicht getestet |
| Stromausfall | Strom im laufenden Betrieb trennen; nach Boot kein „Seiten wiederherstellen“-Hinweis | Nicht getestet |
| Kiosk-Ausbruch | Rechtsklick/Mittelklick während eines Browser-Neustarts, Strg+O, Strg+Umschalt+I, Strg+T, Strg+N, Strg+H, Strg+P, Strg+S, Alt+Tab, Strg+Alt+F2, Alt+Druck+B: kein Menü, Terminal, Dialog, interne Seite oder Konsolenwechsel | Nicht getestet |
| Mauszeiger | Maus 3 s nicht bewegen; Zeiger verschwindet, bei Bewegung wieder sichtbar | Nicht getestet |
| Zugriff im Hotspot | Mit iPhone, Android und Laptop ins Hotspot-WLAN: `https://10.42.0.1:8443` und `https://<hostname>.local:8443` öffnen, SSH auf `10.42.0.1` | Nicht getestet |
| Kein Zugriff über LTE | Von außen (z. B. Handy im Mobilfunk) `https://[<IPv6 des Geräts>]:8443` und `ssh` auf die IPv6 versuchen; beides muss ins Leere laufen. IPv6-Adresse mit `ip -6 addr show dev wwp0s20f0u7i4` | Nicht getestet |
| Internet trotz Firewall | Am Gerät `ping -c3 1.1.1.1` und `ping -6 -c3 2606:4700:4700::1111`; Hotspot-Client erreicht Internet, DHCP und DNS funktionieren | Nicht getestet |
| Update/Rollback | Installer erneut ausführen, danach `rollback.sh`; Inhalt erscheint jeweils wieder | Nicht getestet |

## Reproduzierbare offene Tickets

1. **Debian-13-Grafiktreiber und GPU:** `lspci -nnk`, `xrandr --query`, `chrome://gpu` und Foto des WebGL-Canvas auf dem D613 sichern. Erfolg: Hardwarebeschleunigung aktiv, gewünschte Auflösung stabil.
2. **HDMI/Klinke-Audio:** `wpctl status` je Port und hörbare Testtöne erfassen. Erfolg: beide Testtöne über den gewählten aktiven Ausgang hörbar.
3. **Gamepad-Fokus:** Gerätetyp/Kernel-Ereignis und Testseitenanzeige erfassen. Erfolg: Tastatur und Gamepad erreichen den fokussierten Kiosk nach Boot und Browser-Neustart.
4. **Chromium-Fensterplatzierung:** jeden physischen HDMI-Port dem `xrandr`-Namen zuordnen und Kiosk-Geometrie fotografieren. Erfolg: Single erscheint nur auf dem gewählten Ausgang.
5. **Netz-Recovery:** Browser- und Playerstatus bei LTE-Verlust und Wiederverbindung protokollieren. Erfolg: Inhalt erscheint ohne Bedienung wieder, keine schnelle Neustartschleife.
6. **Hotplug-Erkennung:** Der Player liest den Anzeigezustand alle 10 s mit `xrandr --current`, ohne die Ausgänge neu abzutasten. Am D613 prüfen, ob der Intel-Treiber das Ein-/Ausschalten des Monitors selbst meldet (`journalctl _UID=$(id -u screenable) | grep display_`). Erfolg: `display_disconnected`/`display_reconnected` erscheinen und das Bild kommt zurück.
7. **Hardware-Watchdog:** Prüfen, ob `/dev/watchdog` vorhanden ist (`wdctl`). Falls ja, `RuntimeWatchdogSec=30s` in `/etc/systemd/system.conf.d/` testen: Ein hängendes System startet dann selbständig neu. Erst nach erfolgreichem Test in den Installer übernehmen.
8. **Mehrbildschirm-Modi (V1):** 2–4 Monitore mit `xrandr` anordnen; `--kiosk` gegen `--app` und Openbox-Platzierung vergleichen, Fenstergeometrien und Framerate messen. Erst danach Span/Independent implementieren.
