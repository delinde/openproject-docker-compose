#!/usr/bin/env python3
"""
Webhook: Hocuspocus neustarten via HTTPS
Aufruf: https://openproject.fl.de/ops/restart-hocuspocus?token=<TOKEN>
"""
import http.server
import subprocess
import os
from urllib.parse import urlparse, parse_qs

TOKEN = os.environ["WEBHOOK_TOKEN"]
PORT = int(os.environ.get("WEBHOOK_PORT", "9876"))
COMPOSE_DIR = "/opt/openproject-docker-compose"


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path != "/restart-hocuspocus":
            self._respond(404, "Not found")
            return

        if params.get("token", [""])[0] != TOKEN:
            self._respond(403, "Forbidden")
            return

        result = subprocess.run(
            ["docker", "compose", "restart", "hocuspocus"],
            cwd=COMPOSE_DIR,
            capture_output=True,
            text=True,
        )

        if result.returncode == 0:
            self._respond(200, "OK: Hocuspocus restarted.")
        else:
            self._respond(500, f"Error:\n{result.stderr}")

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, fmt, *args):
        # Zugriffe ins systemd-Journal schreiben (ohne Datum-Prefix)
        print(f"{self.address_string()} {fmt % args}", flush=True)


server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
print(f"Webhook listening on 127.0.0.1:{PORT}", flush=True)
server.serve_forever()
