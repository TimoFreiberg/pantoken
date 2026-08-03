# Mac Mini private remote-access runbook

This is the supported opt-in topology:

```text
iPhone installed PWA -> private HTTPS Tailscale Serve -> 127.0.0.1:<stable-port>
                         -> Pantoken.app supervisor -> bundled pantoken-server
```

The server remains loopback-only. Do not use direct exposure, `0.0.0.0`, port forwarding, Funnel, or a second backend. The separate desktop-initiated SSH remote-target mode remains documented history and is not this topology.

## Setup

1. Install a signed Pantoken.app on the Mac Mini, build the client, and enable the supervised remote mode. Confirm the persisted `hub_port` (8787 by default) and that the server binds to `127.0.0.1`.
2. Configure Tailscale membership and Serve manually to proxy HTTPS to the exact local port. Pantoken does not invoke or mutate the Tailscale CLI.
3. Enter and verify the exact HTTPS origin in Pantoken. Run the opt-in check with `pnpm exec tsx scripts/desktop/tailscale-endpoint-smoke.ts --origin <HTTPS-origin>` and `PANTOKEN_REMOTE_TOKEN` set. It must report the authenticated `/health` identity `service: "pantoken-server"`.
4. Generate a one-time bootstrap link, open it on the iPhone in Safari, and use **Add to Home Screen**. The bootstrap page uses `history.replaceState`, no-store and no-referrer headers; the bearer token must not remain in the URL.

## Acceptance walkthrough

Record device, iOS, Safari/PWA, Pantoken, server, and Tailscale versions in [the validation record](mac-mini-remote-access-validation.md). Test bootstrap persistence, closed-app Web Push, approval deep links, badge set/clear, Wi-Fi/LTE transition, backgrounding, reconnect after hub restart, dark mode, safe areas, and notification behavior. Verify an active turn blocks app replacement. A signed `.app` update is separate from a PWA service-worker/client refresh.

Revoke or regenerate the token after suspected exposure and confirm old credentials receive 401. On teardown, disable remote mode, remove the Serve mapping, revoke the token, and close the app.

## Troubleshooting and security

- **endpoint-unverified:** origin parsing, TLS, or route verification failed.
- **wrong-target:** authenticated health succeeded but the exact identity marker was absent or not `pantoken-server`.
- **hub-unavailable:** the verified endpoint returned a timeout, connection failure, or 5xx.
- **authentication-failure:** the endpoint rejected the bearer credential.

Never paste tokens, bootstrap credentials, URLs containing credentials, or raw headers into logs or evidence. Browser/Playwright tests cannot prove physical iPhone push delivery while closed, standalone PWA storage/lifecycle, LTE reachability, tailnet privacy, or signed app replacement; those require the operator checklist.

## CI boundary

The classifier/unit matrix is hermetic. The endpoint check is opt-in and requires a user-provided HTTPS origin; it never runs as an ordinary CI gate and never changes Tailscale configuration.
