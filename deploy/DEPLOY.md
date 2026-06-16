# Deploying pilot to the Mac Mini ("remote-pilot")

Pilot runs as one process on the Mac Mini, bound to loopback, and is reached over
your tailnet via `tailscale serve` (which terminates TLS for you). No public
exposure, no inbound ports opened on the router.

```
 phone / laptop ──tailnet(TLS)──▶ tailscale serve ──▶ 127.0.0.1:8787 (pilot)
```

## 1. One-time setup on the Mac Mini

```bash
cd ~/src && git clone <your-pilot-remote> pilot   # or already there
cd pilot && bun install

# pick a token and keep it somewhere (1Password etc.)
openssl rand -hex 16
```

## 2. Run it

Manual (foreground, to try it):
```bash
PILOT_TOKEN=<your-token> bun run build && PILOT_TOKEN=<your-token> bun run start
# server logs: http://127.0.0.1:8787  token=required
```

Persistent (launchd — survives reboot/logout):
```bash
# edit the CHANGE-ME token + paths first
cp deploy/com.pilot.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.pilot.server.plist
# tail logs: tail -f ~/Library/Logs/pilot.*.log
```

## 3. Expose over the tailnet

```bash
tailscale serve --bg 8787
# serves https://<mac-mini>.<tailnet>.ts.net  ->  127.0.0.1:8787
tailscale serve status      # confirm the mapping
```
`tailscale serve` proxies WebSocket upgrades, so `/ws` works through it.

## 4. Connect from a device

Open once with the token in the URL; it's saved to localStorage and scrubbed
from the address bar:
```
https://<mac-mini>.<tailnet>.ts.net/?token=<your-token>
```
Then "Add to Home Screen" to install the PWA. Subsequent visits need no token.

## Security notes (see also docs/OPEN-QUESTIONS.md)
- Tailscale is the network boundary (only your tailnet devices can reach the box);
  the token is defense-in-depth on top of that.
- `PILOT_HOST` defaults to `127.0.0.1` — the server is **not** on `0.0.0.0`. Only
  set `0.0.0.0` for bare-LAN use without Tailscale.
- `/debug/*` introspection requires `?token=` when a token is set; set `PILOT_DEBUG=0`
  to disable it entirely in prod.
- pi runs with your user's permissions — sandboxing/approval posture is OQ3/OQ4.
