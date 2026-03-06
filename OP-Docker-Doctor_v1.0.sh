#!/bin/bash

echo "=== OpenProject Collaboration Doctor v3 ==="
echo

check_ok() { echo "✔ $1"; }
check_fail() { echo "✘ $1"; }
recommend() { echo "💡 Hinweis: $1"; }

# ---- Docker läuft?
if docker info >/dev/null 2>&1; then
  check_ok "Docker running"
else
  check_fail "Docker not running"
  recommend "Docker muss laufen, um OpenProject und Hocuspocus zu betreiben"
  exit 1
fi

# ---- Container prüfen
OP_CONTAINER=$(docker ps --format '{{.Names}}' | grep openproject)
HOCUS_CONTAINER=$(docker ps --format '{{.Names}}' | grep hocuspocus)

if [ -n "$OP_CONTAINER" ]; then
  check_ok "OpenProject container running"
else
  check_fail "OpenProject container not running"
  recommend "Überprüfen Sie docker-compose.yml oder Containername"
fi

if [ -n "$HOCUS_CONTAINER" ]; then
  check_ok "Hocuspocus container running"
else
  check_fail "Hocuspocus container missing or stopped"
  recommend "Hocuspocus Container starten"
fi

# ---- OpenProject Logs prüfen
if [ -n "$OP_CONTAINER" ]; then
  if docker logs "$OP_CONTAINER" 2>&1 | grep -qi "hocuspocus"; then
    check_ok "OpenProject mentions Hocuspocus in logs"
  else
    check_fail "No Hocuspocus activity in OpenProject logs"
    recommend "Collaborative Editing aktiviert? (.env oder Docker-Variable OPENPROJECT_COLLABORATIVE__EDITING=true)"
  fi
fi

# ---- Hocuspocus Logs prüfen
if [ -n "$HOCUS_CONTAINER" ]; then
  HOCUS_LOG_ERRORS=$(docker logs "$HOCUS_CONTAINER" 2>&1 | grep -Eiq "auth|secret|connection|refused|error")
  if [ $? -eq 0 ]; then
    check_fail "Hocuspocus logs show possible errors"
    recommend "Logs prüfen: Secret, Token, Auth oder Netzwerkprobleme"
  else
    check_ok "Hocuspocus logs clean"
  fi
fi

# ---- Secret prüfen
if [ -n "$OP_CONTAINER" ] && [ -n "$HOCUS_CONTAINER" ]; then
  OP_SECRET=$(docker exec "$OP_CONTAINER" env | grep HOCUSPOCUS | cut -d= -f2)
  HOCUS_SECRET=$(docker exec "$HOCUS_CONTAINER" env | grep SECRET | cut -d= -f2)
  if [ "$OP_SECRET" = "$HOCUS_SECRET" ] && [ -n "$OP_SECRET" ]; then
    check_ok "Hocuspocus secret matches"
  else
    check_fail "Hocuspocus secret mismatch"
    recommend "Setzen Sie in beiden Containern dasselbe SECRET"
  fi
fi

# ---- Netzwerk prüfen (Ping)
if [ -n "$OP_CONTAINER" ] && [ -n "$HOCUS_CONTAINER" ]; then
  if docker exec "$OP_CONTAINER" ping -c 1 "$HOCUS_CONTAINER" >/dev/null 2>&1; then
    check_ok "OpenProject can reach Hocuspocus container"
  else
    check_fail "OpenProject cannot reach Hocuspocus container"
    recommend "Container müssen im gleichen Docker-Netzwerk sein"
  fi
fi

# ---- WebSocket-Test
if [ -n "$HOCUS_CONTAINER" ]; then
  HOCUS_PORT=$(docker ps | grep hocuspocus | awk '{print $NF}' | awk -F: '{print $2}')
  if docker exec "$OP_CONTAINER" bash -c "echo 'GET /' | nc -w 2 $HOCUS_CONTAINER $HOCUS_PORT" >/dev/null 2>&1; then
    check_ok "WebSocket port reachable"
  else
    check_fail "WebSocket port not reachable"
    recommend "Firewall prüfen / Reverse Proxy WebSocket-Passthrough aktivieren"
  fi
fi

# ---- Reverse Proxy erkennen
if docker ps | grep -Eiq "nginx|traefik|caddy"; then
  check_ok "Reverse Proxy detected"
  recommend "Stellen Sie sicher, dass WebSocket-Pass-Through aktiviert ist"
else
  check_ok "No Reverse Proxy detected"
fi

# ---- Collaborative Editing aktiviert?
if [ -n "$OP_CONTAINER" ]; then
  COLLAB=$(docker exec "$OP_CONTAINER" env | grep COLLABORATIVE)
  if echo "$COLLAB" | grep -q "true"; then
    check_ok "Collaborative Editing activated"
  else
    check_fail "Collaborative Editing not activated"
    recommend "OPENPROJECT_COLLABORATIVE__EDITING=true setzen und Container neu starten"
  fi
fi

echo
echo "=== Diagnosis complete ==="



