# OpenProject 17 hinter nginx mit HTTPS – Einrichtung und Fehleranalyse

Erstellt: 2026-02-24
Kontext: Produktivinstallation auf Debian/Ubuntu-Server,
         Domain: openproject.fl.de, Let's Encrypt SSL-Zertifikat

---

## 1. Richtige Einstellungen für OpenProject 17 hinter nginx

### Architektur

```
Browser (HTTPS)
    │
    ▼
nginx (Port 443, SSL-Terminierung, Host)
    │  proxy_pass http://localhost:8080
    ▼
Caddy-Proxy (Docker-Container, Port 127.0.0.1:8080)
    │  /hocuspocus* → hocuspocus:1234
    │  *            → web:8080
    ▼
OpenProject web-Container (Port 8080, intern HTTP)
    +── worker-Container
    +── cron-Container
    +── hocuspocus-Container (Port 1234, WebSocket)
    +── db (PostgreSQL)
    +── cache (Memcached)
```

---

### Datei: `/etc/nginx/sites-enabled/openproject`

```nginx
# Redirect von op.fl.de (Alias) zu Hauptdomain
server {
    listen 80;
    listen 443 ssl;
    server_name op.fl.de;
    ssl_certificate /etc/letsencrypt/live/openproject.fl.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openproject.fl.de/privkey.pem;
    return 301 https://openproject.fl.de$request_uri;
}

# HTTP → HTTPS erzwingen
server {
    listen 80;
    server_name openproject.fl.de;
    return 301 https://$host$request_uri;
}

# Hauptkonfiguration (HTTPS)
server {
    listen 443 ssl;
    server_name openproject.fl.de;

    ssl_certificate /etc/letsencrypt/live/openproject.fl.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openproject.fl.de/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;  # ← fest "https", nicht $scheme
        proxy_set_header X-Forwarded-Host $host;

        # WebSocket-Support (erforderlich für Hocuspocus / kollaboratives Editieren)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
```

---

### Datei: `/opt/openproject-docker-compose/.env`

```env
TAG=17-slim

# WICHTIG: Muss "true" bleiben, auch wenn nginx SSL terminiert!
# (Erklärung siehe Abschnitt 3, Phase 5)
OPENPROJECT_HTTPS=true

OPENPROJECT_HOST__NAME=openproject.fl.de
PORT=127.0.0.1:8080

# Langen Zufallsstring verwenden:
# head /dev/urandom | tr -dc A-Za-z0-9 | head -c 48 ; echo ''
SECRET_KEY_BASE=<langer-zufallsstring-ohne-sonderzeichen>

OPENPROJECT_RAILS__RELATIVE__URL__ROOT=
IMAP_ENABLED=false

DATABASE_URL=postgres://postgres:<db-passwort>@db/openproject?pool=20&encoding=unicode&reconnect=true

RAILS_MIN_THREADS=4
RAILS_MAX_THREADS=16

PGDATA="/var/lib/postgresql/data"
OPDATA="/var/openproject/assets"

# wss:// (nicht ws://) weil Browser über HTTPS verbunden ist
COLLABORATIVE_SERVER_URL=wss://openproject.fl.de/hocuspocus

# Gemeinsames Geheimnis zwischen OpenProject und Hocuspocus
COLLABORATIVE_SERVER_SECRET=<sicherer-zufallsstring>

# OPENPROJECT_URL wird NICHT gesetzt → greift der Default: http://web:8080
```

---

### Nach Änderungen: alle relevanten Container neu starten

```bash
docker compose up -d --force-recreate web worker cron hocuspocus
```

---

## 2. Chronologischer Fehlersuchbericht

### Phase 1 – Bereinigung der .env

Die Ausgangsdatei enthielt **doppelte Variablendefinitionen**: Mehrere
Einstellungen waren zweimal vorhanden (einmal mit Platzhaltern, einmal
mit echten Werten). Docker Compose verwendet stets den letzten Wert –
das funktioniert, ist aber fehleranfällig. Die Duplikate wurden entfernt
und die echten Werte direkt an die richtige Stelle gesetzt.

### Phase 2 – Docker startet nicht (Port 8080 belegt)

Beim ersten `docker compose down && up` schlug der Start des
`proxy`-Containers fehl:

```
Bind for 0.0.0.0:8080 failed: port is already allocated
```

Ursache: Eine ältere, parallel laufende OpenProject-Installation
(Container ohne `-docker-compose` im Namen, seit 36 Stunden aktiv)
belegte Port 8080. Diese Container wurden manuell gestoppt:

```bash
docker stop openproject-proxy-1 openproject-cron-1 \
            openproject-worker-1 openproject-web-1
```

Danach startete die neue Installation erfolgreich.

### Phase 3 – 502 Bad Gateway unter https://openproject.fl.de

Obwohl alle Container liefen, lieferte die Seite einen 502-Fehler.

Diagnose:
- nginx läuft auf dem Host (Port 80 + 443), besitzt ein gültiges
  Let's Encrypt-Zertifikat und leitet an `localhost:8080` weiter.
- Der `proxy`-Container hatte beim fehlgeschlagenen ersten Start
  eine fehlerhafte Netzwerkkonfiguration erhalten (keine Port-Bindung).

Lösung:
```bash
docker compose up -d --force-recreate proxy
```

Gleichzeitig wurde die nginx-Konfiguration überarbeitet:
- Port 80 → 301-Redirect zu HTTPS
- Port 443: WebSocket-Header (`Upgrade`, `Connection`) ergänzt
- `proxy_read_timeout 300s` für lang laufende Verbindungen

### Phase 4a – Hocuspocus: falsche COLLABORATIVE_SERVER_URL

Der Browser meldete: *"Der Server für Echtzeit-Kollaboration ist nicht
erreichbar."*

Der konfigurierte Wert `ws://localhost:8080/hocuspocus` ist die
interne Server-Adresse. Der Browser interpretiert `localhost` als
seinen eigenen Rechner und kann den Server nicht erreichen.

Korrektur in `.env`:
```
COLLABORATIVE_SERVER_URL=wss://openproject.fl.de/hocuspocus
```

`wss://` statt `ws://`, weil der Browser über HTTPS verbunden ist
(Browser blockieren Mixed Content: kein `ws://` von einer HTTPS-Seite).

### Phase 4b – Hocuspocus: `fetch failed`

Nach der URL-Korrektur zeigten die Hocuspocus-Logs:

```
[onAuthenticate] fetch failed
```

Hocuspocus rief intern `http://web:8080/api/v3/documents/3` auf.
Test bestätigte:

```
HTTP/1.1 301 Moved Permanently
location: https://web:8080/api/v3
```

Ursache: `OPENPROJECT_HTTPS=true` aktiviert in Rails `force_ssl=true`.
Jede HTTP-Anfrage wird auf HTTPS umgeleitet. `https://web:8080`
existiert intern nicht → Verbindungsfehler.

Provisorische Lösung (stellte sich als falsch heraus):
```
OPENPROJECT_HTTPS=false
```

### Phase 4c – Hocuspocus: `Token origin does not match request origin`

Mit `OPENPROJECT_HTTPS=false` erreichte Hocuspocus OpenProject
(Antwort: 401 statt Redirect). Aber die Token-Validierung schlug fehl:

```
[onAuthenticate] Unauthorized: Token origin does not match request origin.
```

**Ursache (aus Quellcode-Lektüre ermittelt):**

Das JWT-Token enthält eine `resource_url`, z.B.:
`http://openproject.fl.de/api/v3/documents/3`

Der Browser verbindet sich via WebSocket mit:
`Origin: https://openproject.fl.de`

Hocuspocus prüft (Quellcode `openProjectApi.ts`):
```typescript
if (requestOrigin && !tokenResourceUrl?.startsWith(requestOrigin)) {
    throw new Error('Unauthorized: Token origin does not match request origin.');
}
```

`"http://openproject.fl.de/...".startsWith("https://openproject.fl.de")`
→ `false` → Fehler.

Mit `OPENPROJECT_HTTPS=false` generiert OpenProject HTTP-Tokens.
Der Browser kommt aber über HTTPS. Mismatch.

### Phase 5 – Die Lösung (Quellcode als Schlüssel)

Erst das Lesen von `resourceService.ts` im Hocuspocus-Container
offenbarte den eigentlichen Designmechanismus:

```typescript
// resourceService.ts
const headers: Record<string, string> = {
    ...(OPENPROJECT_URL && OPENPROJECT_HTTPS && { "X-Forwarded-Proto": "https" })
};
```

**Hocuspocus sendet den Header `X-Forwarded-Proto: https` an OpenProject
genau dann, wenn `OPENPROJECT_HTTPS=true` UND `OPENPROJECT_URL` gesetzt
sind.**

Rails mit `force_ssl=true` prüft vor dem Redirect:

```ruby
request.ssl?  # true, wenn X-Forwarded-Proto: https gesetzt
```

Ist `request.ssl?` bereits `true`, erfolgt kein weiterer Redirect.
OpenProject verarbeitet die Anfrage und generiert Tokens mit
`https://`-Origin.

Der elegante Zirkelschluss des Designs:
- `OPENPROJECT_HTTPS=true` → force_ssl aktiv → Hocuspocus sendet Header
- Header → force_ssl leitet nicht weiter → Authentifizierung klappt
- Tokens tragen `https://`-Origin → Browser-Origin stimmt überein ✓

**Lösung:**
```bash
# .env: OPENPROJECT_HTTPS=true (zurücksetzen)
# ALLE Container neu starten – auch Hocuspocus!
docker compose up -d --force-recreate web worker cron hocuspocus
# Browser-Seite neu laden (alter Token war ungültig)
```

**Der entscheidende Fehler in früheren Versuchen:** Hocuspocus wurde
nicht mit neu gestartet, hatte also noch `OPENPROJECT_HTTPS=false`
im Speicher und sendete den notwendigen Header nicht.

---

## 3. Was hätten die OpenProject-Entwickler besser machen können?

### 3a. Hätte der Fehler verhindert werden können?

**Ja.** Drei Versäumnisse der Auslieferung:

1. **Die `.env`-Vorlage ist für HTTP konfiguriert, ohne das zu
   dokumentieren.** `OPENPROJECT_HTTPS=false` und
   `ws://localhost:8080/hocuspocus` implizieren HTTP-Direktzugriff.
   Wer – wie in professionellen Installationen üblich – nginx davorstellt,
   erhält keine Anleitung für den Umstieg.

2. **Das Zusammenspiel `OPENPROJECT_HTTPS=true` ↔ Hocuspocus-Header
   ist nirgendwo dokumentiert.** Der Mechanismus ist nur im Quellcode
   (`resourceService.ts`) sichtbar. Kein Kommentar in `docker-compose.yml`,
   kein Hinweis in `.env.example`, kein Abschnitt im README.

3. **Kein Hinweis auf `wss://` statt `ws://` bei HTTPS-Betrieb.**

### 3b. Konkrete Verbesserungsvorschläge

**1. `.env.example` erweitern:**
```env
# ----------------------------------------------------------------
# Betrieb hinter nginx/Apache mit SSL-Zertifikat (empfohlene Prod-Konfig)
# ----------------------------------------------------------------
# ACHTUNG: OPENPROJECT_HTTPS=true ist auch dann nötig, wenn nginx
# das SSL terminiert! Hocuspocus benötigt diesen Wert, um korrekte
# https://-Tokens zu generieren und den force_ssl-Redirect zu umgehen.
OPENPROJECT_HTTPS=true
OPENPROJECT_HOST__NAME=ihre-domain.de

# wss:// (WebSocket over TLS) wenn der Browser über HTTPS kommt:
COLLABORATIVE_SERVER_URL=wss://ihre-domain.de/hocuspocus
```

**2. README: Abschnitt "Betrieb hinter Reverse Proxy + SSL"** mit
nginx-Musterkonfiguration (inkl. WebSocket-Headers).

**3. Kommentar in `docker-compose.yml`:**
```yaml
hocuspocus:
  environment:
    # Wenn OPENPROJECT_HTTPS=true: Hocuspocus sendet X-Forwarded-Proto: https
    # an den web-Container. Das verhindert den force_ssl-Redirect und
    # stellt sicher, dass Tokens https://-Origin tragen.
    OPENPROJECT_HTTPS: "${OPENPROJECT_HTTPS:-true}"
```

**4. Bessere Fehlermeldung in Hocuspocus:**
Statt: `Token origin does not match request origin`
Besser: `Token origin (http://) does not match request origin (https://).
         Verify that OPENPROJECT_HTTPS=true is set and all containers
         have been restarted.`

**5. Startzeit-Validierung:**
Wenn `COLLABORATIVE_SERVER_URL` mit `wss://` beginnt, aber
`OPENPROJECT_HTTPS=false`, sollte Hocuspocus beim Start warnen.

---

## 4. Feedback an OpenProject geben

**GitHub Issues (bevorzugt für technische Beiträge):**

- Für docker-compose-spezifische Probleme:
  `https://github.com/opf/openproject-deploy/issues`
- Für das OpenProject-Hauptprojekt:
  `https://github.com/opf/openproject/issues`

**Empfohlener Issue-Titel:**
> Documentation: OPENPROJECT_HTTPS must remain true behind
> SSL-terminating reverse proxy (Hocuspocus auth broken otherwise)

**Community-Forum:**
`https://community.openproject.org/`

Ein präzises GitHub-Issue mit Verweis auf die `resourceService.ts`-Logik
wäre der wertvollste Beitrag – direkt umsetzbar für die Entwickler und
hilfreich für alle anderen Nutzer mit derselben Konfiguration.

---

*Erstellt mit Claude Code (claude-sonnet-4-6) im Rahmen einer
Einrichtungssitzung am 2026-02-24.*
