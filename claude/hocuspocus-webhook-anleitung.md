# Hocuspocus-Neustart per Browser-Link

## Was ist das?

Hocuspocus ist der Dienst, der das **gemeinsame Bearbeiten von Dokumenten** in OpenProject ermöglicht (mehrere Personen gleichzeitig im selben Dokument). Gelegentlich verliert er die Verbindung oder arbeitet nicht mehr zuverlässig — dann hilft ein Neustart.

Mit dem hier beschriebenen Webhook können Sie Hocuspocus **mit einem einzigen Klick im Browser** neu starten, ohne sich per SSH einloggen zu müssen.

---

## Benutzung

### Der Neustart-Link (als Lesezeichen speichern!)

```
https://openproject.fl.de/ops/restart-hocuspocus?token=Paßwort:hokusp998
```

Einfach diesen Link im Browser aufrufen. Nach wenigen Sekunden erscheint:

> `OK: Hocuspocus restarted.`

Das war's. Hocuspocus läuft wieder neu.

### Was die Antworten bedeuten

| Antwort | Bedeutung |
|---|---|
| `OK: Hocuspocus restarted.` | Erfolgreich. Fertig. |
| `Forbidden` | Falsches Passwort im Link. Link prüfen. |
| Keine Antwort / Timeout | Server nicht erreichbar oder Webhook-Dienst ausgefallen (→ SSH nötig). |

---

## Wann sollte ich neu starten?

- Gemeinsames Bearbeiten funktioniert nicht mehr (Editor lädt, aber Änderungen werden nicht synchronisiert)
- Der Browser zeigt eine Verbindungsfehlermeldung im Dokument-Editor
- Ein Kollege kann ein Dokument nicht gemeinsam bearbeiten, obwohl er eingeloggt ist
- Nach dem Tipp von Claude: „Starten Sie Hocuspocus neu"

**Hinweis:** Ein Neustart dauert ca. 5–10 Sekunden. Wer gerade ein Dokument bearbeitet, merkt kurz eine Unterbrechung und muss ggf. die Seite neu laden.

---

## Sicherheit

- Der Link funktioniert **nur mit dem richtigen Passwort** (`Paßwort:hokusp998`)
- Die Verbindung ist **verschlüsselt** (HTTPS)
- Der Endpunkt ist **nicht öffentlich auffindbar** (kein Index, kein Link auf der Seite)
- Das Schlimmste, was jemand mit dem Link tun kann: Hocuspocus neu starten — keine Datenlöschung, kein Zugriff auf Inhalte

---

## Technische Details (für Admins / zukünftige Wartung)

### Komponenten

| Datei | Zweck |
|---|---|
| `/opt/openproject-docker-compose/webhook-restart-hocuspocus.py` | Python-HTTP-Server (lauscht auf 127.0.0.1:9876) |
| `/etc/hocuspocus-webhook.env` | Token und Port (nur root lesbar, `chmod 600`) |
| `/etc/systemd/system/hocuspocus-webhook.service` | Systemd-Dienst (startet automatisch beim Server-Reboot) |
| nginx-Block `location = /ops/restart-hocuspocus` | Leitet HTTPS-Anfragen an Port 9876 weiter |

### Dienst-Verwaltung

```bash
# Status prüfen
systemctl status hocuspocus-webhook.service

# Logs ansehen
journalctl -u hocuspocus-webhook.service -n 30

# Neustart des Webhook-Dienstes selbst (z.B. nach Token-Änderung)
systemctl restart hocuspocus-webhook.service
```

### Token ändern

1. Datei bearbeiten: `nano /etc/hocuspocus-webhook.env`
2. `WEBHOOK_TOKEN=NeuesPasswort` setzen
3. Dienst neu starten: `systemctl restart hocuspocus-webhook.service`
4. Den Link in diesem Dokument und im Browser-Lesezeichen aktualisieren

### Warum wird Hocuspocus überhaupt unpäßlich?

Häufigste Ursachen (aus Log-Analyse):

1. **Session-Ablauf** — Ein Browser-Tab hatte ein Dokument geöffnet. Nach ~24h läuft die OpenProject-Anmeldesitzung ab. Hocuspocus versucht danach jede Minute, den abgelaufenen Token zu erneuern, bis der Tab geschlossen wird. Das ist kein Fehler, sondern normales Verhalten — aber es kann Ressourcen binden.

2. **Speicherwachstum** — Hocuspocus läuft in Node.js und hält jedes geöffnete Dokument im Arbeitsspeicher. Nach langer Laufzeit kann er träge werden. Ein Neustart leert den Speicher.

3. **web-Container-Neustart** — Wenn der OpenProject-Hauptcontainer neu startet, werden alle Anmeldesitzungen ungültig. Laufende Hocuspocus-Verbindungen verlieren dadurch ihre Authentifizierung.
