# GitHub Issue – Entwurf
# Einzureichen unter: https://github.com/opf/openproject-deploy/issues/new
# Sprache: Englisch (Standard für GitHub)
# ============================================================

## TITEL (Title)

Documentation: `OPENPROJECT_HTTPS=true` must remain set when running behind
an SSL-terminating reverse proxy (nginx/Apache) — Hocuspocus auth breaks otherwise


## TEXT (Body)

### Summary

When running the OpenProject docker-compose stack behind an SSL-terminating
reverse proxy (e.g. nginx or Apache with a Let's Encrypt certificate),
collaborative document editing fails with:

> "The document cannot be opened because the real-time collaboration server
> is not reachable."

The Hocuspocus container logs show:

```
[onAuthenticate] Unauthorized: Token origin does not match request origin.
```

This happens because the shipped `.env` defaults
(`OPENPROJECT_HTTPS=false`, `COLLABORATIVE_SERVER_URL=ws://localhost:8080/hocuspocus`)
are designed for direct HTTP access only. There is no documentation for
the correct configuration when using an SSL-terminating reverse proxy.


### Environment

- OpenProject: 17-slim (docker-compose stack)
- Hocuspocus: 17.1.0
- Reverse proxy: nginx with Let's Encrypt certificate (SSL termination at nginx)
- Stack layout: Browser → nginx (443) → Caddy proxy (127.0.0.1:8080) → web container


### Root Cause

The issue has two interrelated parts:

**Part 1 — Wrong `COLLABORATIVE_SERVER_URL`**

The default `ws://localhost:8080/hocuspocus` is a server-side address.
Browsers interpret `localhost` as their own machine and cannot reach the server.
When accessed over HTTPS, browsers also block mixed content (no `ws://` from
an `https://` page).

Fix: `COLLABORATIVE_SERVER_URL=wss://your-domain.com/hocuspocus`

**Part 2 — The non-obvious role of `OPENPROJECT_HTTPS=true`**

Reading the Hocuspocus source code (`src/services/resourceService.ts`)
reveals a critical design detail that is **not documented anywhere**:

```typescript
const headers: Record<string, string> = {
    ...(OPENPROJECT_URL && OPENPROJECT_HTTPS && { "X-Forwarded-Proto": "https" })
};
```

Hocuspocus sends the `X-Forwarded-Proto: https` header to OpenProject
**only when both `OPENPROJECT_URL` and `OPENPROJECT_HTTPS=true` are set**.

This header is essential because:

1. OpenProject with `OPENPROJECT_HTTPS=true` has Rails `force_ssl` active.
   When Hocuspocus calls `http://web:8080/api/v3/...`, Rails checks
   `request.ssl?`. If `X-Forwarded-Proto: https` is present, `request.ssl?`
   returns `true` and **no redirect is triggered** — the API call succeeds.

2. Without this header (i.e. when `OPENPROJECT_HTTPS=false`), the internal
   HTTP call from Hocuspocus gets a `301 → https://web:8080/...` redirect,
   which fails because the web container has no TLS listener.

3. With `OPENPROJECT_HTTPS=false`, OpenProject generates tokens containing
   `http://your-domain.com` as the origin. The browser's WebSocket connection
   sends `Origin: https://your-domain.com`. The origins don't match →
   authentication fails.

**In short:** `OPENPROJECT_HTTPS=true` must remain set even when nginx
terminates SSL, because it controls both the token origin scheme AND
activates the internal `X-Forwarded-Proto` header that prevents the
force_ssl redirect loop.


### Correct Configuration (nginx + Let's Encrypt)

**`.env`:**
```env
OPENPROJECT_HTTPS=true                                    # must be true
OPENPROJECT_HOST__NAME=your-domain.com
PORT=127.0.0.1:8080
COLLABORATIVE_SERVER_URL=wss://your-domain.com/hocuspocus # wss://, not ws://
COLLABORATIVE_SERVER_SECRET=<shared-secret>
# Do NOT set OPENPROJECT_URL → default http://web:8080 is correct
```

**nginx (`/etc/nginx/sites-enabled/openproject`):**
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;  # hardcoded, not $scheme
        proxy_set_header X-Forwarded-Host $host;

        # Required for Hocuspocus WebSocket
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```


### Suggested Improvements

**1. Update `.env.example`** to include a documented HTTPS/reverse-proxy block:

```env
# ----------------------------------------------------------------
# When running behind nginx/Apache with SSL certificate:
# ----------------------------------------------------------------
# IMPORTANT: Keep OPENPROJECT_HTTPS=true even when nginx terminates SSL.
# Hocuspocus uses this value to send X-Forwarded-Proto: https to the
# web container, preventing a force_ssl redirect loop and ensuring
# tokens carry an https:// origin (required for browser WebSocket auth).
OPENPROJECT_HTTPS=true
OPENPROJECT_HOST__NAME=your-domain.com
COLLABORATIVE_SERVER_URL=wss://your-domain.com/hocuspocus
```

**2. Add a comment in `docker-compose.yml`** to the hocuspocus environment block:

```yaml
hocuspocus:
  environment:
    # When OPENPROJECT_HTTPS=true: Hocuspocus sends X-Forwarded-Proto: https
    # to the web container. This prevents the force_ssl redirect and ensures
    # tokens carry an https:// origin, matching the browser's WebSocket origin.
    OPENPROJECT_HTTPS: "${OPENPROJECT_HTTPS:-true}"
```

**3. Add a README section** "Running behind a reverse proxy with SSL"
with the complete nginx configuration and the explanation above.

**4. Improve the Hocuspocus error message:**

Current: `Token origin does not match request origin.`

Suggested: `Token origin (http://) does not match WebSocket request origin (https://).
This usually means OPENPROJECT_HTTPS is not set to true, or the Hocuspocus
container was not restarted after changing this value.`

**5. Add a startup warning in Hocuspocus** when
`COLLABORATIVE_SERVER_URL` starts with `wss://` but `OPENPROJECT_HTTPS`
is not `true`.


### Impact

This combination (nginx SSL termination + docker-compose) is the standard
production setup for self-hosted OpenProject installations. Without this
documentation, every administrator using a proper SSL setup will hit this
problem. The root cause is entirely non-obvious and requires reading the
Hocuspocus source code to diagnose.


---
*Diagnosed and documented during a real production setup session,
2026-02-24.*
