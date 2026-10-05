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

Auf dem D613 `node /opt/screenable-player/scripts/diagnostic-server.mjs` starten und im Dashboard als Inhalt `http://localhost:8090/diagnostic.html` setzen. Die Testseite zeigt WebGL, Tastatur- und Gamepad-Ereignisse sowie das Ergebnis von WebAudio-, HTML-Audio- und Video-Autoplay. Lautsprecher an HDMI und Klinke einzeln anschließen; die API-Erfolgsmeldung allein zählt nicht als hörbarer Ton. Für jede Prüfung **Bestanden / Fehlgeschlagen / Nicht getestet**, Foto oder Log und Datum erfassen. Nach dem Test den Diagnose-Server beenden und die produktive URL wiederherstellen.

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
| Netzwerkverlust | Kabel ziehen, wieder stecken; Fehler und Erholung prüfen | Nicht getestet |
| Display-Auswahl | Jeden realen HDMI-Ausgang einzeln im Dashboard wählen | Nicht getestet |

## Reproduzierbare offene Tickets

1. **Debian-13-Grafiktreiber und GPU:** `lspci -nnk`, `xrandr --query`, `chrome://gpu` und Foto des WebGL-Canvas auf dem D613 sichern. Erfolg: Hardwarebeschleunigung aktiv, gewünschte Auflösung stabil.
2. **HDMI/Klinke-Audio:** `wpctl status` je Port und hörbare Testtöne erfassen. Erfolg: beide Testtöne über den gewählten aktiven Ausgang hörbar.
3. **Gamepad-Fokus:** Gerätetyp/Kernel-Ereignis und Testseitenanzeige erfassen. Erfolg: Tastatur und Gamepad erreichen den fokussierten Kiosk nach Boot und Browser-Neustart.
4. **Chromium-Fensterplatzierung:** jeden physischen HDMI-Port dem `xrandr`-Namen zuordnen und Kiosk-Geometrie fotografieren. Erfolg: Single erscheint nur auf dem gewählten Ausgang.
5. **Netz-Recovery:** Browser- und Playerstatus bei Kabelverlust und Wiederverbindung protokollieren. Erfolg: Inhalt erscheint ohne Bedienung wieder, keine schnelle Neustartschleife.
6. **Mehrbildschirm-Modi (V1):** 2–4 Monitore mit `xrandr` anordnen; `--kiosk` gegen `--app` und Openbox-Platzierung vergleichen, Fenstergeometrien und Framerate messen. Erst danach Span/Independent implementieren.
