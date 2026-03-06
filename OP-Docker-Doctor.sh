#!/bin/bash
# ================================================================
#  OP-Docker-Doctor.sh
#  OpenProject 17 – Collaboration Doctor
#  Diagnose · Therapie · Prophylaxe
#  Version 4.0 – 2026-02
# ================================================================
#
#  Aufruf:  bash /opt/openproject-docker-compose/OP-Docker-Doctor.sh
#  Optional: COMPOSE_DIR=/anderer/pfad bash OP-Docker-Doctor.sh
#
# ================================================================

# ── Farben ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Zähler & Therapieliste ────────────────────────────────────────
ERRORS=0; WARNINGS=0
THERAPIE_STEPS=()

# ── Hilfsfunktionen ───────────────────────────────────────────────
ok()      { echo -e "  ${GREEN}✔${NC}  $1"; }
fail()    { echo -e "  ${RED}✘${NC}  $1"; ((ERRORS++)); }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $1"; ((WARNINGS++)); }
info()    { echo -e "  ${BLUE}ℹ${NC}  $1"; }
tip()     { echo -e "     ${YELLOW}→${NC} $1"; }
step()    { THERAPIE_STEPS+=("$1"); }
comment() { THERAPIE_STEPS+=("# $1"); }

section() {
    echo
    echo -e "${BOLD}${CYAN}━━━  $1${NC}"
}

# .env-Wert lesen (letzter Eintrag gewinnt bei Duplikaten)
get_env() { grep "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }

# ── Pfade ─────────────────────────────────────────────────────────
COMPOSE_DIR="${COMPOSE_DIR:-/opt/openproject-docker-compose}"
ENV_FILE="$COMPOSE_DIR/.env"

# ================================================================
echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║    OpenProject 17 – Collaboration Doctor   v4.0      ║"
echo "  ║    Diagnose · Therapie · Prophylaxe                   ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  Prüft die häufigste Fehlerursache:"
echo -e "  ${RED}\"Das Dokument kann nicht geöffnet werden, da der Server"
echo -e "  für Echtzeit-Kollaboration nicht erreichbar ist.\"${NC}"
echo


# ================================================================
section "A)  Grundvoraussetzungen"
# ================================================================

# Docker läuft?
if docker info >/dev/null 2>&1; then
    ok "Docker läuft"
else
    fail "Docker läuft nicht"
    tip "Starten mit: systemctl start docker"
    exit 1
fi

# Compose-Verzeichnis?
if [ -d "$COMPOSE_DIR" ]; then
    ok "Compose-Verzeichnis: $COMPOSE_DIR"
else
    fail "Compose-Verzeichnis nicht gefunden: $COMPOSE_DIR"
    tip "Tipp: COMPOSE_DIR=/ihr/pfad bash OP-Docker-Doctor.sh"
    exit 1
fi

# docker-compose.yml?
if [ -f "$COMPOSE_DIR/docker-compose.yml" ]; then
    ok "docker-compose.yml vorhanden"
else
    fail "docker-compose.yml fehlt in $COMPOSE_DIR"
    exit 1
fi

# .env?
if [ -f "$ENV_FILE" ]; then
    ok ".env-Datei vorhanden"
else
    fail ".env fehlt – bitte aus .env.example erstellen"
    comment "Konfigurationsdatei erstellen"
    step "cp $COMPOSE_DIR/.env.example $ENV_FILE && nano $ENV_FILE"
fi

# .env-Werte einlesen
HTTPS_VAL=$(get_env OPENPROJECT_HTTPS)
HOST_VAL=$(get_env OPENPROJECT_HOST__NAME)
COLLAB_URL_VAL=$(get_env COLLABORATIVE_SERVER_URL)
COLLAB_SECRET_VAL=$(get_env COLLABORATIVE_SERVER_SECRET)
SECRET_KEY_VAL=$(get_env SECRET_KEY_BASE)
PORT_VAL=$(get_env PORT)


# ================================================================
section "B)  Port-Konflikte (alte Container)"
# ================================================================

# Port dieser Installation aus PORT_VAL extrahieren (z.B. "127.0.0.1:8082" → "8082")
THIS_PORT=$(echo "${PORT_VAL:-8080}" | grep -oE '[0-9]+$')

OLD_CONTAINERS=$(docker ps --format '{{.Names}}\t{{.Ports}}' \
    | grep "${THIS_PORT}->80" \
    | grep -v "$(basename "$COMPOSE_DIR")" 2>/dev/null)

if [ -n "$OLD_CONTAINERS" ]; then
    fail "Fremde Container belegen Port ${THIS_PORT}:"
    echo "$OLD_CONTAINERS" | while IFS= read -r line; do
        tip "$line"
    done
    tip "Diese müssen gestoppt werden, bevor der proxy-Container starten kann."
    comment "Alte Container stoppen"
    while IFS=$'\t' read -r name _; do
        step "docker stop $name"
    done <<< "$OLD_CONTAINERS"
    step "cd $COMPOSE_DIR && docker compose up -d"
else
    ok "Kein Port-${THIS_PORT}-Konflikt durch alte Container"
fi


# ================================================================
section "C)  Container-Status"
# ================================================================

cd "$COMPOSE_DIR" || exit 1

WEB_OK=false; HOCUS_OK=false

check_service() {
    local svc="$1"
    local status
    status=$(docker compose ps --format '{{.Status}}' "$svc" 2>/dev/null | head -1)
    if [ -z "$status" ]; then
        fail "Container '$svc' nicht gefunden / nie gestartet"
        step "cd $COMPOSE_DIR && docker compose up -d $svc"
        return 1
    elif echo "$status" | grep -qi "exit\|stop"; then
        fail "Container '$svc' gestoppt  ($status)"
        step "cd $COMPOSE_DIR && docker compose start $svc"
        return 1
    else
        ok "Container '$svc' läuft  ($status)"
        return 0
    fi
}

check_service web     && WEB_OK=true
check_service hocuspocus && HOCUS_OK=true
check_service proxy
check_service worker
check_service db
check_service cache


# ================================================================
section "D)  .env – Die kritischen Einstellungen"
# ================================================================

# ── OPENPROJECT_HTTPS ──────────────────────────────────────────
if [ "$HTTPS_VAL" = "true" ]; then
    ok "OPENPROJECT_HTTPS=true"
    info "Wichtig: Auch hinter nginx/SSL-Proxy muss dieser Wert 'true' bleiben!"
else
    fail "OPENPROJECT_HTTPS=${HTTPS_VAL:-<nicht gesetzt>}  ← muss 'true' sein"
    tip "Hintergrund: Hocuspocus sendet X-Forwarded-Proto: https an OpenProject"
    tip "nur wenn OPENPROJECT_HTTPS=true. Ohne diesen Header schlägt die"
    tip "Token-Origin-Prüfung fehl → Kollaboration funktioniert nicht."
    comment "OPENPROJECT_HTTPS korrigieren"
    step "sed -i 's/^OPENPROJECT_HTTPS=.*/OPENPROJECT_HTTPS=true/' $ENV_FILE"
    step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web worker cron hocuspocus"
    step "# Dann Browser-Seite neu laden: Strg+Shift+R (neuer Token nötig)"
fi

# ── OPENPROJECT_HOST__NAME ─────────────────────────────────────
if [ -z "$HOST_VAL" ]; then
    fail "OPENPROJECT_HOST__NAME ist nicht gesetzt"
    step "# In $ENV_FILE eintragen: OPENPROJECT_HOST__NAME=ihre-domain.de"
elif echo "$HOST_VAL" | grep -qi "localhost"; then
    warn "OPENPROJECT_HOST__NAME=$HOST_VAL  (enthält 'localhost')"
    tip "Für Produktivbetrieb bitte echte Domain eintragen."
else
    ok "OPENPROJECT_HOST__NAME=$HOST_VAL"
fi

# ── COLLABORATIVE_SERVER_URL ───────────────────────────────────
if [ -z "$COLLAB_URL_VAL" ]; then
    fail "COLLABORATIVE_SERVER_URL ist nicht gesetzt"
    step "# In $ENV_FILE eintragen: COLLABORATIVE_SERVER_URL=wss://${HOST_VAL:-ihre-domain.de}/hocuspocus"

elif echo "$COLLAB_URL_VAL" | grep -qi "localhost\|127\.0\.0\.1"; then
    fail "COLLABORATIVE_SERVER_URL=$COLLAB_URL_VAL  ← 'localhost' ist falsch"
    tip "'localhost' bedeutet für den Browser: sein eigener Rechner, nicht der Server."
    FIXED_URL="wss://${HOST_VAL:-ihre-domain.de}/hocuspocus"
    step "sed -i 's|^COLLABORATIVE_SERVER_URL=.*|COLLABORATIVE_SERVER_URL=$FIXED_URL|' $ENV_FILE"
    step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web worker cron"

elif echo "$COLLAB_URL_VAL" | grep -q "^ws://"; then
    fail "COLLABORATIVE_SERVER_URL=$COLLAB_URL_VAL  ← ws:// statt wss://"
    tip "Browser auf HTTPS-Seiten blockieren unsichere ws://-Verbindungen (Mixed Content)."
    FIXED_URL=$(echo "$COLLAB_URL_VAL" | sed 's|^ws://|wss://|')
    step "sed -i 's|^COLLABORATIVE_SERVER_URL=.*|COLLABORATIVE_SERVER_URL=$FIXED_URL|' $ENV_FILE"
    step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web worker cron"

else
    ok "COLLABORATIVE_SERVER_URL=$COLLAB_URL_VAL"
fi

# ── SECRET_KEY_BASE ────────────────────────────────────────────
if [ -z "$SECRET_KEY_VAL" ] \
    || [ "$SECRET_KEY_VAL" = "OVERWRITE_ME" ] \
    || [ "$SECRET_KEY_VAL" = "OVERRIDE_ME_PLEASE" ]; then
    fail "SECRET_KEY_BASE ist noch ein Platzhalter oder leer"
    tip "Generieren: head /dev/urandom | tr -dc A-Za-z0-9 | head -c 48 ; echo"
    step "# Neuen Wert generieren und in $ENV_FILE eintragen"
    step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web worker cron"
else
    ok "SECRET_KEY_BASE gesetzt  (${#SECRET_KEY_VAL} Zeichen)"
fi

# ── COLLABORATIVE_SERVER_SECRET ────────────────────────────────
if [ -z "$COLLAB_SECRET_VAL" ] \
    || echo "$COLLAB_SECRET_VAL" | grep -qi "override\|overwrite\|placeholder"; then
    warn "COLLABORATIVE_SERVER_SECRET scheint ein Standardwert zu sein"
    tip "Eigenen Zufallswert verwenden für mehr Sicherheit."
else
    ok "COLLABORATIVE_SERVER_SECRET gesetzt"
fi


# ================================================================
section "E)  Laufende Container-Konfiguration"
# ================================================================

if $HOCUS_OK; then

    # Hocuspocus: OPENPROJECT_HTTPS?
    HOCUS_HTTPS=$(docker compose exec -T hocuspocus \
        printenv OPENPROJECT_HTTPS 2>/dev/null | tr -d '\r\n')
    if [ "$HOCUS_HTTPS" = "true" ]; then
        ok "Hocuspocus: OPENPROJECT_HTTPS=true  (sendet X-Forwarded-Proto: https ✓)"
    else
        fail "Hocuspocus: OPENPROJECT_HTTPS=${HOCUS_HTTPS:-<leer>}"
        tip "Der Container wurde nach der letzten .env-Änderung nicht neu gestartet"
        tip "oder OPENPROJECT_HTTPS ist in .env noch auf 'false'."
        step "cd $COMPOSE_DIR && docker compose up -d --force-recreate hocuspocus"
        step "# Browser-Seite neu laden: Strg+Shift+R"
    fi

    # Hocuspocus: OPENPROJECT_URL?
    HOCUS_URL=$(docker compose exec -T hocuspocus \
        printenv OPENPROJECT_URL 2>/dev/null | tr -d '\r\n')
    if [ -z "$HOCUS_URL" ] || [ "$HOCUS_URL" = "http://web:8080" ]; then
        ok "Hocuspocus: OPENPROJECT_URL=http://web:8080  (interner HTTP-Zugriff, korrekt)"
    elif echo "$HOCUS_URL" | grep -q "^http://"; then
        ok "Hocuspocus: OPENPROJECT_URL=$HOCUS_URL  (HTTP intern)"
    else
        warn "Hocuspocus: OPENPROJECT_URL=$HOCUS_URL  (ungewöhnlicher Wert)"
        tip "Standard und empfohlen: http://web:8080"
    fi

    # Secret-Abgleich
    if $WEB_OK; then
        OP_SECRET=$(docker compose exec -T web \
            printenv OPENPROJECT_COLLABORATIVE__EDITING__HOCUSPOCUS__SECRET \
            2>/dev/null | tr -d '\r\n')
        HC_SECRET=$(docker compose exec -T hocuspocus \
            printenv SECRET 2>/dev/null | tr -d '\r\n')

        if [ -n "$OP_SECRET" ] && [ "$OP_SECRET" = "$HC_SECRET" ]; then
            ok "Shared Secret stimmt in beiden Containern überein"
        elif [ -z "$OP_SECRET" ] && [ -z "$HC_SECRET" ]; then
            warn "Shared Secret in beiden Containern leer (Standardwert?)"
        else
            fail "Secret-Mismatch zwischen OpenProject und Hocuspocus"
            tip "OpenProject:  ${OP_SECRET:0:6}..."
            tip "Hocuspocus:   ${HC_SECRET:0:6}..."
            step "# COLLABORATIVE_SERVER_SECRET in $ENV_FILE auf einheitlichen Wert setzen"
            step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web hocuspocus"
        fi
    fi

fi


# ================================================================
section "F)  Interne Netzwerk-Erreichbarkeit"
# ================================================================

if $HOCUS_OK; then
    # Prüfen ob web-Container noch startet
    WEB_STATUS=$(docker compose ps --format '{{.Status}}' web 2>/dev/null | head -1)
    if echo "$WEB_STATUS" | grep -qi "starting"; then
        warn "web-Container noch am Hochfahren ($WEB_STATUS) – Netzwerktest übersprungen"
        info "Bitte in ~60 Sekunden erneut ausführen."
    else
        # Hocuspocus → web: HTTP-Aufruf MIT X-Forwarded-Proto: https
        # (so wie Hocuspocus es bei OPENPROJECT_HTTPS=true selbst macht)
        HTTP_CODE=$(docker compose exec -T hocuspocus \
            wget -qO /dev/null \
                 --server-response \
                 --header="X-Forwarded-Proto: https" \
                 http://web:8080/api/v3 2>&1 \
            | grep "HTTP/" | tail -1 | awk '{print $2}')

        case "$HTTP_CODE" in
            200|401)
                ok "Hocuspocus → OpenProject intern: HTTP $HTTP_CODE  (korrekt)"
                info "401 = nicht authentifiziert, aber erreichbar – das ist richtig so."
                ;;
            301|302)
                fail "OpenProject leitet Hocuspocus intern weiter: HTTP $HTTP_CODE → HTTPS"
                tip "Ursache: web-Container hat OPENPROJECT_HTTPS=false"
                tip "         oder Hocuspocus sendet keinen X-Forwarded-Proto: https."
                step "# In $ENV_FILE: OPENPROJECT_HTTPS=true"
                step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web worker cron hocuspocus"
                ;;
            "")
                fail "Hocuspocus: keine Antwort von web-Container"
                tip "web-Container läuft möglicherweise nicht oder ist noch nicht bereit."
                step "cd $COMPOSE_DIR && docker compose up -d web"
                ;;
            *)
                warn "Unerwarteter HTTP-Status vom web-Container: $HTTP_CODE"
                ;;
        esac
    fi
fi


# ================================================================
section "G)  nginx-Konfiguration"
# ================================================================

NGINX_RUNNING=false
if systemctl is-active --quiet nginx 2>/dev/null || pgrep -x nginx >/dev/null 2>&1; then
    ok "nginx läuft auf dem Host"
    NGINX_RUNNING=true
else
    info "Kein nginx gefunden – kein externer Reverse Proxy aktiv."
fi

if $NGINX_RUNNING; then

    NGINX_CONF=$(grep -rl "${HOST_VAL:-openproject}" \
        /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -1)

    if [ -n "$NGINX_CONF" ]; then
        ok "nginx-Konfiguration gefunden: $NGINX_CONF"

        # WebSocket-Header?
        if grep -q "Upgrade" "$NGINX_CONF" 2>/dev/null; then
            ok "WebSocket-Header (Upgrade / Connection) vorhanden"
        else
            fail "WebSocket-Header fehlen in $NGINX_CONF"
            tip "Ohne diese Header funktioniert Hocuspocus (WebSocket) nicht."
            tip "Benötigt im nginx location-Block:"
            echo "       proxy_http_version 1.1;"
            echo "       proxy_set_header Upgrade \$http_upgrade;"
            echo "       proxy_set_header Connection \"upgrade\";"
            step "# WebSocket-Header in $NGINX_CONF ergänzen"
            step "nginx -t && nginx -s reload"
        fi

        # X-Forwarded-Proto: https?
        if grep -q "X-Forwarded-Proto.*https" "$NGINX_CONF" 2>/dev/null; then
            ok "X-Forwarded-Proto: https wird weitergeleitet"
        else
            warn "X-Forwarded-Proto: https fehlt oder ist dynamisch (\$scheme)"
            tip "Empfehlung: 'proxy_set_header X-Forwarded-Proto https;'  (fest, nicht \$scheme)"
        fi

        # HTTP→HTTPS-Redirect?
        if grep -q "return 301 https" "$NGINX_CONF" 2>/dev/null; then
            ok "HTTP→HTTPS-Redirect konfiguriert"
        else
            warn "Kein HTTP→HTTPS-Redirect in nginx gefunden"
            tip "Empfehlung: Port-80-Block mit 'return 301 https://\$host\$request_uri;'"
        fi

    else
        warn "Keine nginx-Konfiguration für '${HOST_VAL:-openproject}' gefunden"
        info "Gesucht in: /etc/nginx/sites-enabled/ und /etc/nginx/conf.d/"
    fi
fi


# ================================================================
section "H)  Hocuspocus-Log-Analyse"
# ================================================================

if $HOCUS_OK; then

    LOGS=$(docker compose logs hocuspocus --tail=100 2>/dev/null)

    FOUND_ISSUE=false

    if echo "$LOGS" | grep -q "fetch failed"; then
        fail "Log-Muster gefunden: 'fetch failed'"
        tip "Hocuspocus kann OpenProject intern nicht erreichen."
        tip "Ursache: HTTP-Anfrage wird auf https:// umgeleitet (force_ssl)."
        tip "Lösung:  OPENPROJECT_HTTPS=true + alle Container neu starten."
        comment "Therapie für 'fetch failed'"
        step "sed -i 's/^OPENPROJECT_HTTPS=.*/OPENPROJECT_HTTPS=true/' $ENV_FILE"
        step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web worker cron hocuspocus"
        FOUND_ISSUE=true
    fi

    if echo "$LOGS" | grep -q "Token origin does not match"; then
        fail "Log-Muster gefunden: 'Token origin does not match request origin'"
        tip "Browser-Token enthält http:// als Origin, Browser verbindet aber über https://."
        tip "Ursache 1: OPENPROJECT_HTTPS=false → Token enthält http://-Origin."
        tip "Ursache 2: Hocuspocus nach .env-Änderung nicht neu gestartet."
        tip "Ursache 3: Browser hat alten Token noch → Seite neu laden (Strg+Shift+R)."
        comment "Therapie für 'Token origin does not match'"
        step "sed -i 's/^OPENPROJECT_HTTPS=.*/OPENPROJECT_HTTPS=true/' $ENV_FILE"
        step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web hocuspocus"
        step "# Dann Browser-Seite neu laden: Strg+Shift+R  (wichtig!)"
        FOUND_ISSUE=true
    fi

    if echo "$LOGS" | grep -qi "invalid secret\|secret mismatch\|wrong secret"; then
        fail "Log-Muster gefunden: Secret-Fehler"
        tip "COLLABORATIVE_SERVER_SECRET stimmt nicht zwischen OpenProject und Hocuspocus überein."
        comment "Therapie für Secret-Mismatch"
        step "# COLLABORATIVE_SERVER_SECRET in $ENV_FILE prüfen und angleichen"
        step "cd $COMPOSE_DIR && docker compose up -d --force-recreate web hocuspocus"
        FOUND_ISSUE=true
    fi

    if ! $FOUND_ISSUE; then
        ok "Keine kritischen Fehlermuster in Hocuspocus-Logs (letzte 100 Zeilen)"
    fi

    # Gibt es erfolgreiche Verbindungen?
    AUTH_COUNT=$(echo "$LOGS" | grep -c "onAuthenticate\|onLoadDocument\|onStoreDocument" 2>/dev/null | tr -d '[:space:]')
    AUTH_COUNT="${AUTH_COUNT:-0}"
    if [ "$AUTH_COUNT" -gt 0 ] 2>/dev/null; then
        ok "Hocuspocus zeigt Aktivität: $AUTH_COUNT Authentifizierungs-/Dokument-Ereignisse"
    fi

fi


# ================================================================
section "I)  Zusammenfassung"
# ================================================================

echo
if   [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}✔  Alles in Ordnung!${NC}"
    echo -e "  ${GREEN}   OpenProject und Hocuspocus sind korrekt konfiguriert.${NC}"
elif [ $ERRORS -eq 0 ]; then
    echo -e "  ${YELLOW}${BOLD}⚠  $WARNINGS Warnung(en), keine kritischen Fehler.${NC}"
    echo -e "  ${YELLOW}   Kollaboration sollte funktionieren. Hinweise beachten.${NC}"
else
    echo -e "  ${RED}${BOLD}✘  $ERRORS Fehler  /  $WARNINGS Warnung(en) gefunden.${NC}"
    echo -e "  ${RED}   Kollaboratives Editieren funktioniert wahrscheinlich nicht.${NC}"
fi


# ================================================================
if [ ${#THERAPIE_STEPS[@]} -gt 0 ]; then
section "J)  Therapie – Empfohlene Befehle (zum Kopieren)"
    echo
    i=1
    for s in "${THERAPIE_STEPS[@]}"; do
        if echo "$s" | grep -q "^# "; then
            echo -e "  ${BLUE}${s}${NC}"
        else
            echo -e "  ${BOLD}$i.${NC}  $s"
            ((i++))
        fi
    done
fi


# ================================================================
section "K)  Prophylaxe – Das müssen Sie wissen"
# ================================================================

cat <<'PROPHYLAXE'

  Das Zusammenspiel: Browser → nginx → Caddy → OpenProject/Hocuspocus
  ─────────────────────────────────────────────────────────────────────

   Browser (HTTPS)
     │  wss://domain.de/hocuspocus  (WebSocket über TLS)
     ▼
   nginx  (Port 443, SSL-Terminierung, Let's Encrypt)
     │  → proxy_set_header X-Forwarded-Proto https;
     │  → proxy_set_header Upgrade $http_upgrade;   ← für WebSocket!
     ▼
   Caddy-Proxy  (127.0.0.1:8080, interner Docker-Proxy)
     ├── /hocuspocus* ──► hocuspocus:1234
     └── *            ──► web:8080
     ▼
   OpenProject web-Container  (HTTP intern, Port 8080)

  ─────────────────────────────────────────────────────────────────────
  Warum OPENPROJECT_HTTPS=true auch hinter nginx?  (nicht-intuitiv!)
  ─────────────────────────────────────────────────────────────────────

  Hocuspocus-Quellcode (resourceService.ts):

    const headers = {
      ...(OPENPROJECT_URL && OPENPROJECT_HTTPS &&
          { "X-Forwarded-Proto": "https" })   // ← nur wenn HTTPS=true!
    };

  OPENPROJECT_HTTPS=true bewirkt gleichzeitig drei Dinge:

  1. Hocuspocus sendet X-Forwarded-Proto: https an OpenProject.
     → Rails sieht request.ssl?=true → kein HTTP→HTTPS-Redirect ✓

  2. OpenProject generiert Tokens mit https://-Origin.
     → Token-Origin stimmt mit Browser-WebSocket-Origin überein ✓

  3. OpenProject generiert korrekte https://-Links für den Browser. ✓

  ─────────────────────────────────────────────────────────────────────
  Schnell-Checkliste bei Fehler "Echtzeit-Kollaboration nicht erreichbar"
  ─────────────────────────────────────────────────────────────────────

   □  OPENPROJECT_HTTPS=true              (in .env – auch hinter nginx!)
   □  COLLABORATIVE_SERVER_URL=wss://...  (wss://, kein ws://, kein localhost)
   □  ALLE Container neu starten:
      docker compose up -d --force-recreate web worker cron hocuspocus
   □  Browser-Seite neu laden:  Strg+Shift+R  (Mac: Cmd+Shift+R)
      (alter Token im Browser ist sonst ungültig)

  ─────────────────────────────────────────────────────────────────────
  Typische Fehlermeldungen und ihre Bedeutung
  ─────────────────────────────────────────────────────────────────────

   "fetch failed"
     → Hocuspocus → http://web:8080 → 301-Weiterleitung auf https://
     → OPENPROJECT_HTTPS war false, web hat force_ssl aktiv
     → Lösung: OPENPROJECT_HTTPS=true + alle Container neu starten

   "Token origin does not match request origin"
     → Token hat http://-Origin, Browser verbindet über https://
     → OPENPROJECT_HTTPS=false oder Hocuspocus nicht neu gestartet
     → Lösung: OPENPROJECT_HTTPS=true + Hocuspocus + Browser neu laden

   "502 Bad Gateway" (im Browser)
     → Proxy-Container läuft nicht oder bindet Port 8080 nicht
     → docker compose up -d --force-recreate proxy

   "Port 8080 already allocated"
     → Alte Container einer früheren Installation belegen den Port
     → Alte Container stoppen: docker stop <container-name>

PROPHYLAXE

echo -e "  ${BLUE}Hocuspocus-Logs live lesen:${NC}"
echo -e "    docker compose logs hocuspocus --tail=30 -f"
echo
echo -e "  ${BLUE}Ausführlicher Bericht zu dieser Konfiguration:${NC}"
echo -e "    $COMPOSE_DIR/claude/openproject17-nginx-https-bericht.md"
echo
echo -e "  ${BLUE}Feedback / Issue an OpenProject-Entwickler:${NC}"
echo -e "    https://github.com/opf/openproject-deploy/issues"
echo

echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  OpenProject 17 – Collaboration Doctor  ·  Ende der Diagnose"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
