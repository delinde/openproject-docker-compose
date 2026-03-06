# Empfehlung: Wie sollte OpenProject 17 ab Werk ausgeliefert werden?

Erstellt: 2026-02-24
Grundlage: Praxiserfahrung bei der Einrichtung hinter nginx mit Let's Encrypt

---

## Ist-Zustand: Ab-Werk-.env.example

```env
TAG=17-slim
OPENPROJECT_HTTPS=false                                ← ① falsch
SECRET_KEY_BASE=OVERWRITE_ME                           ← ② Platzhalter
OPENPROJECT_HOST__NAME=localhost                       ← ③ nur lokal
PORT=127.0.0.1:8080
OPENPROJECT_RAILS__RELATIVE__URL__ROOT=
IMAP_ENABLED=false
DATABASE_URL=postgres://postgres:p4ssw0rd@db/openproject?...
RAILS_MIN_THREADS=4
RAILS_MAX_THREADS=16
PGDATA="/var/lib/postgresql/data"
OPDATA="/var/openproject/assets"
COLLABORATIVE_SERVER_URL=ws://localhost:8080/hocuspocus ← ④ falsch
COLLABORATIVE_SERVER_SECRET=secret12345                ← ⑤ zu schwach
```

---

## Die fünf Ab-Werk-Fehler im Detail

### ① OPENPROJECT_HTTPS=false

**Problem:** Für den direkten HTTP-Betrieb gedacht.
Bei jedem professionellen Setup (nginx + SSL-Zertifikat) führt dieser
Wert zum Fehler "Token origin does not match request origin".

**Nicht-intuitiv:** Dieser Wert muss `true` bleiben, auch wenn nginx
das SSL terminiert. Hocuspocus sendet `X-Forwarded-Proto: https` an
OpenProject nur wenn `OPENPROJECT_HTTPS=true` – das verhindert den
force_ssl-Redirect-Loop und erzeugt korrekte https://-Tokens.

**Empfehlung:** Standard auf `true` ändern, mit erklärendem Kommentar.

---

### ② SECRET_KEY_BASE=OVERWRITE_ME

**Problem:** Sicherheitsrisiko – wird manchmal vergessen.

**Empfehlung:** Den Generierungsbefehl direkt ausführbar machen:
```bash
SECRET_KEY_BASE=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 48)
```

---

### ③ OPENPROJECT_HOST__NAME=localhost

**Problem:** Nur für rein lokalen Betrieb. Bei externer Domain
werden Links falsch generiert.

**Empfehlung:** Wert leer lassen oder deutlicher als Pflichtfeld markieren.

---

### ④ COLLABORATIVE_SERVER_URL=ws://localhost:8080/hocuspocus

**Problem:** Doppelt falsch:
- `ws://` statt `wss://` → Browser blockiert Mixed Content auf HTTPS-Seiten
- `localhost` → Browser verbindet mit seinem eigenen Rechner, nicht dem Server

**Empfehlung:** Standard auf `wss://${OPENPROJECT_HOST__NAME}/hocuspocus`
setzen (dynamisch aus HOST__NAME ableiten) oder leer lassen mit
erklärendem Pflichtfeld-Kommentar.

---

### ⑤ COLLABORATIVE_SERVER_SECRET=secret12345

**Problem:** Ein bekannter Standardwert ist kein Geheimnis.

**Empfehlung:** Wie SECRET_KEY_BASE als Platzhalter mit Generierungshinweis.

---

## Soll-Zustand: Empfohlene .env.example für Produktiveinsatz

```env
##
# OpenProject 17 – Konfigurationsdatei
# Dokumentation aller Variablen:
#   https://www.openproject.org/docs/installation-and-operations/configuration/environment/
##

TAG=17-slim

# ── Domäne und HTTPS ────────────────────────────────────────────────────
# Ihre öffentliche Domain (ohne https://):
OPENPROJECT_HOST__NAME=ihre-domain.de

# WICHTIG: Auf 'true' lassen, auch wenn nginx/Apache das SSL terminiert!
# Hintergrund: Hocuspocus sendet X-Forwarded-Proto: https an OpenProject
# nur wenn dieser Wert 'true' ist. Ohne diesen Header schlägt die
# WebSocket-Authentifizierung fehl ("Token origin does not match").
# Siehe: https://github.com/opf/openproject-deploy/issues/...
OPENPROJECT_HTTPS=true

# ── Sicherheitsschlüssel ────────────────────────────────────────────────
# Zufallswert generieren:
#   head /dev/urandom | tr -dc A-Za-z0-9 | head -c 48 ; echo
# Niemals den Standardwert verwenden!
SECRET_KEY_BASE=BITTE_ERSETZEN

# ── Netzwerk ────────────────────────────────────────────────────────────
# Port-Bindung des Caddy-Proxys (nur localhost – nginx leitet weiter):
PORT=127.0.0.1:8080

# ── Kollaboratives Editieren (Hocuspocus) ───────────────────────────────
# URL für den Browser zum WebSocket-Server.
# wss:// (nicht ws://) – Browser blockieren ws:// auf HTTPS-Seiten.
# Kein 'localhost' – der Browser würde seinen eigenen Rechner meinen.
COLLABORATIVE_SERVER_URL=wss://ihre-domain.de/hocuspocus

# Gemeinsames Geheimnis zwischen OpenProject und Hocuspocus.
# Zufallswert generieren (wie SECRET_KEY_BASE oben):
COLLABORATIVE_SERVER_SECRET=BITTE_ERSETZEN

# ── Datenbank ───────────────────────────────────────────────────────────
DATABASE_URL=postgres://postgres:p4ssw0rd@db/openproject?pool=20&encoding=unicode&reconnect=true

# ── Weitere Einstellungen ───────────────────────────────────────────────
OPENPROJECT_RAILS__RELATIVE__URL__ROOT=
IMAP_ENABLED=false
RAILS_MIN_THREADS=4
RAILS_MAX_THREADS=16
```

---

## nginx-Musterkonfiguration (sollte im README stehen)

```nginx
# /etc/nginx/sites-enabled/openproject

server {
    listen 80;
    server_name ihre-domain.de;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ihre-domain.de;

    ssl_certificate /etc/letsencrypt/live/ihre-domain.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ihre-domain.de/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;  # fest "https", nicht $scheme

        # WebSocket-Support (erforderlich für kollaboratives Editieren):
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

---

## Zusammenfassung: Was die OpenProject-Entwickler ändern sollten

| Priorität | Datei | Änderung |
|-----------|-------|----------|
| 🔴 Kritisch | `.env.example` | `OPENPROJECT_HTTPS=true` mit erklärendem Kommentar |
| 🔴 Kritisch | `.env.example` | `COLLABORATIVE_SERVER_URL=wss://ihre-domain.de/hocuspocus` |
| 🔴 Kritisch | `docker-compose.yml` | Kommentar zum OPENPROJECT_HTTPS-Hocuspocus-Mechanismus |
| 🟡 Wichtig | `README.md` | Abschnitt "Betrieb hinter nginx mit SSL" + Musterkonfig |
| 🟡 Wichtig | `.env.example` | `SECRET_KEY_BASE` und `COLLABORATIVE_SERVER_SECRET` als Pflichtfelder |
| 🟢 Hilfreich | Hocuspocus | Klarere Fehlermeldung bei Token-Origin-Mismatch |
| 🟢 Hilfreich | Hocuspocus | Startup-Warnung wenn wss:// aber OPENPROJECT_HTTPS≠true |

---

*Erstellt nach Praxisdiagnose mit OP-Docker-Doctor.sh, 2026-02-24*
