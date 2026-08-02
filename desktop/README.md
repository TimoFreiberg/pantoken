# Pantoken desktop shell (Tauri)

The macOS desktop app: a Tauri v2 shell that supervises a **local pantoken server** as a
sidecar and hosts the server-served web client in a chromeless window. It replaced the
hand-rolled Swift/AppKit shell (now deleted — see `docs/ADR-desktop-shell.md` for the
decision and the spike results).

The hub is a **compiled Rust binary** (`pantoken-server`, built from `server/`),
shipped as `Contents/MacOS/pantoken-server` in the packaged .app. It serves the bundled
client (`Contents/Resources/client-dist`). The updater swaps shell + server + client
**atomically**. No external package manager, no clone, no external checkout needed on the machine.

`PANTOKEN_HUB_MODE=bundled` forces the bundled path (useful for testing a debug binary as
if it were packaged). A .app missing its server/client payload fails with a fatal
dialog, never a silent fallback. What's new over Swift:

- **Whole-app self-update** via `tauri-plugin-updater` (minisign-signed artifacts, our
  key, no Apple involvement) — the Swift shell could only nag you to rebuild by hand.
- **Tray-resident lifetime**: closing the window keeps the process — and therefore the
  server and any phone connection — alive. The tray menu has Open / Copy App URL /
  Restart Server / Check for Shell Updates / Quit.
- **Single-instance**: a second launch focuses the running app.
- **Supervision in Rust**: health-gated boot, KeepAlive respawn, liveness probe
  (restart a hung-but-running server), crash-loop breaker, SIGTERM-safe teardown
  (a signal routes through the same cleanup as Cmd+Q — no orphaned processes).

## Mac Mini lifecycle

Launch-at-login is **opt-in** and is controlled by macOS `SMAppService.mainApp`; Pantoken never
creates a helper, launch agent, or silent fallback. Settings reads the actual Service Management
status and reports disabled, registered, approval-required, failure, and unavailable states.
Only a signed packaged macOS app is authoritative for registration; debug/non-macOS builds report
unavailable rather than pretending to be registered.

A login launch starts the tray, supervised hub, and remote bridge headlessly. Tray **Open** creates
(or reveals) and focuses the window. Closing the window hides it and leaves the hub and phone access
alive; explicit **Quit** (tray, Cmd+Q, signal, or updater relaunch) performs complete teardown.
Supervisor diagnostics expose safe endpoint metadata, health/recovery state, timestamps, and restart
reason. They never include bearer tokens, Authorization headers, or query credentials. Failed or
unauthorized health is fail-closed for updater idle decisions.

The supported v1 path is the signed app's Service Management registration. User-managed Login Items
or launch-agent workarounds are non-v1 and are not configured by Pantoken. Packaged manual checks (including `scripts/desktop/validate-macos-app.sh --app PATH`) remain required for reboot/login, approval/error messaging, close-versus-Quit, update persistence, and uninstall behavior. The validator checks the packaged `Contents/Info.plist`; source metadata alone is not evidence of registration eligibility.

## How it works

On launch, the shell resolves its explicit local/remote mode before starting the sidecar:

1. Local mode picks a free loopback port; remote mode uses the persisted `hub_port` (8787 by
   default) and never randomizes on invalid or occupied configuration.
2. Resolves config: data dir, hub binary path, client-dist path, and (remote mode only) the
   Keychain bearer token (`src/config.rs`). Remote mode always forces `127.0.0.1`.
3. Shows the bundled "Starting Pantoken…" page, spawns the `pantoken-server` sidecar
   with `PANTOKEN_CLIENT_DIST` pointing at the bundled client, and gates on authenticated
   `GET /health` when remote mode is enabled.
4. Local mode navigates the webview to `http://127.0.0.1:<port>/`; authenticated desktop
   static/document delivery is deferred to issue #148/03 because this Tauri shell has no
   request-header interception seam. The shell then starts its periodic update loop.

Remote mode is an opt-in, loopback-only backend-preparation path for the phone contract. It
persists `~/Library/Application Support/Pantoken/remote-access.json` (schema 1) and keeps the
secret only in macOS Keychain, service `dev.pantoken.app.remote-access`, account
`bearer-token`. Local mode retains random loopback ports and omits `PANTOKEN_TOKEN`; remote
mode supplies a non-empty Keychain token and authenticated internal `/health` and `/update/state` calls
(authenticated internal health/update calls). Token values are never logged, persisted in ordinary URLs, or included
in diagnostics. A missing/unavailable Keychain item, malformed settings, invalid origin, or
port collision fails closed with an actionable error.

The server's remote contract requires `Authorization: Bearer <token>` on `/health`,
`/push/*`, `/update/state`, `/debug/*`, and ordinary static/document requests. Missing,
malformed, duplicate, wrong, or query-token credentials return HTTP `401` with body
`unauthorized`; unsupported methods retain HTTP `405` precedence. The `/ws` upgrade rejects
`?token=` with `401`, then authenticates the first Hello message before registration. Local
mode keeps existing no-token development compatibility. The one-time `/bootstrap` exchange,
authenticated desktop document delivery, and Settings/tray bootstrap UX are explicitly owned
by issue #148/03; no loopback/static auth exemption is used here.

The supervisor loop respawns the server on exit (a crash) and re-navigates the webview so
fresh client assets show. Rapid exits (<5s uptime) count toward a 6-strike crash-loop
breaker that surfaces a fatal dialog instead of spinning. A healthy server that stops
answering /health for ~30s is SIGTERM'd and respawned. On quit — window Quit, Cmd+Q,
SIGTERM, logout — the child is SIGTERM'd (SIGKILL after 5s if ignored).

## Build & run

```bash
cd desktop
pnpm run dev     # tauri dev — debug build
pnpm run build   # tauri build — release .app under target/release/bundle/macos/
```

Rust toolchain required (`rustup`); everything else comes through the pnpm workspace.
`cargo check` / `cargo clippy` in this directory for fast iteration.

Both commands first compile the server sidecar (`scripts/desktop/build-hub.ts` →
`binaries/pantoken-server-<triple>`, gitignored) because tauri-build stages `externalBin`
next to the binary and errors when it's missing; `pnpm run build` additionally builds
the client (bundled as the `client-dist` resource).

Release builds want the updater signing key in the environment, or they can't produce
updater artifacts:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pantoken-shell.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
pnpm run build
```

### Installing a release

The bundle is **ad-hoc signed, not notarized** (personal tool posture, same as the
Swift shell). That means a **browser-downloaded** copy carries the quarantine xattr
and Gatekeeper refuses it outright — the misleading *"Pantoken.app is damaged and can't
be opened"* dialog, with no Open-Anyway path on current macOS (the right-click → Open
bypass no longer applies to ad-hoc apps). Install without a browser instead:

```bash
# one-liner (resolves the right arch + extracts to /Applications):
curl -fsSL https://raw.githubusercontent.com/TimoFreiberg/pantoken/main/install.sh | bash
# or, the bare curl+tar the script wraps:
curl -sSL https://github.com/TimoFreiberg/pantoken/releases/latest/download/Pantoken.app.tar.gz \
  | tar xz -C /Applications
```

curl sets no quarantine attribute, so the app opens normally. Already downloaded a
"damaged" copy? Un-quarantine it: `xattr -cr /path/to/Pantoken.app`. After the first
launch the app updates itself (self-applied updates never re-acquire quarantine —
verified in the ADR spike).

### Test/dev launches

The shell honors override vars the server never exports (so a launch from inside a
pantoken-spawned agent shell can't be hijacked by inherited config):

- `PANTOKEN_HUB_MODE` — `bundled`, forcing the bundled path on a non-.app binary
- `PANTOKEN_APP_DATA_DIR` — the data dir (default `~/Library/Application Support/Pantoken`)

The documented development overrides are passed to the spawned server, so
`PANTOKEN_DRIVER=mock PANTOKEN_UPDATE_DRY_RUN=1` gives a fully hermetic instance; auth
and unrelated configuration variables are explicitly filtered:

```bash
PANTOKEN_APP_DATA_DIR=$(mktemp -d) \
PANTOKEN_DRIVER=mock PANTOKEN_UPDATE_DRY_RUN=1 ../target/debug/pantoken-desktop
```

Agent-legible probes: stderr logs `pantoken: hub healthy <N>ms after launch` and
`pantoken: fatal: …`; the server's `/health` + `/debug/state` work as always.

## Updates

One updater artifact is the whole app (shell + server + client), so the shell's own
periodic loop (`src/updater.rs`) owns updates, checked every minute
(`PANTOKEN_SHELL_UPDATE_INTERVAL_MS`):

- unattended & idle (no client connected, no turn running per `/health`) → install +
  relaunch silently;
- anything else → defer: POST `/update/state` to the server — which raises the
  sidebar's "Update available" card. The click ("Update now", or force-update from
  the build-stamp menu) comes back on the next 5s poll and triggers the install.

An install swaps the .app in place, relaunches, and the fresh server serves the fresh
client — the never-restart-mid-turn guarantee holds. Install failures un-stick the
card (`applyFailed`) so it offers retry without deleting sessions or manually restarting.

Remote Mini/apply contract:

- The phone action is authenticated through the existing bearer-token session. The shell
  sends `Authorization: Bearer <token>` on `/health`, `/update/state`, and the one-shot
  `/update/permit/consume` check; tokens never appear in URLs or evidence. Revoke or rotate
  the remote-access token through the existing remote-access settings/bootstrap procedure
  after suspected exposure; subsequent requests fail closed with `401 unauthorized`.
- An active or initializing turn is fail-closed: the card says it is deferred and no
  install or relaunch begins. The final health check and short-lived SHA-bound permit are
  rechecked atomically immediately before signed installation.
- During install the card explains the temporary Pantoken.app restart and reconnect. The
  reconnect presentation is bounded; timeout leaves a retryable failure while retaining
  the staged version. A later retry can succeed normally.
- This signed whole-app update is separate from the PWA service-worker `Refresh` action,
  which only calls `window.location.reload()`. `forceUpdate` remains a desktop-shell-only
  control and is not exposed as a phone workaround.
- Manual Mini/iPhone validation must redact bearer tokens, URLs containing credentials, and
  diagnostic payloads. Browser tests cannot prove iOS push delivery, LTE transitions,
  tailnet reachability, or real signed `.app` replacement; those remain opt-in device checks.

**Endpoint**, resolved at runtime, re-checked every cycle:

1. `PANTOKEN_SHELL_UPDATE_URL` env var — the literal `off` disables checks (hermetic runs)
2. a `shell-update-url` file in the data dir (one URL on a line)
3. the baked-in default: the public releases repo,
   `https://github.com/TimoFreiberg/pantoken/releases/latest/download/latest.json`

So installed apps update out of the box; the overrides exist for tests and for
pointing a machine at alternative hosting (e.g. a tailnet static dir).

## Publishing a release

The normal path is one command; CI does the heavy lifting:

```bash
just release                                # --patch (default), --minor, --major, --version X.Y.Z
```

It bumps the version (tauri.conf.json + Cargo.toml + lock), commits `Release vX.Y.Z`,
tags it (via the colocated `.git` — jj can't create tags), moves `main`, and pushes.
The tag triggers ci.yml's `release-prepare` job, which builds signed on a macOS
runner (headless artifacts via Buck2 — `build.ts --builder buck2` in release
mode — desktop via Tauri/Cargo) while the web + desktop gates run; once those
gates pass, `release` publishes the prepared artifacts via `publish.ts`. Running
apps pick the release up within a minute. One-time setup: the minisign key as an
Actions secret —

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/pantoken-shell.key
```

(Owner call, 2026-07-03: the key lives in Actions secrets. Fork PRs never see
secrets, so the exposure is the GitHub account itself — accepted for a single-user
tool, and it doubles as a key backup.)

`publish.ts` also works standalone from this machine (`--repo
TimoFreiberg/pantoken`, `--dry-run` to inspect): it builds signed (key from
`TAURI_SIGNING_PRIVATE_KEY` or `~/.tauri/pantoken-shell.key`), **derives `latest.json`
from the built bundle's Info.plist** — a hand-typed manifest version over an older
artifact makes every relaunch "update" again, an infinite install loop under the
unattended policy — and publishes tar.gz + sig + manifest as a GitHub release,
refusing to reuse an existing tag. In CI it additionally gets `--tag-must-match` so a
manifest can never disagree with the pushed tag.

Plain-http endpoints are currently allowed (`dangerousInsecureTransportProtocol` in
`tauri.conf.json`) — tolerable because update integrity comes from the minisign
signature, not the transport. **Remove the flag once hosting lands on https** (GitHub
releases would do it): the plugin's https-only rule is release-builds-only, so local
updater testing on debug builds keeps working either way.

**Keys:** the minisign keypair lives at `~/.tauri/pantoken-shell.key` (+`.pub`),
passwordless — it never leaves this machine. The public key is baked into
`tauri.conf.json`. Losing the private key means shipping one manual reinstall with a
new keypair; **regenerating it invalidates every installed app's update path**, so
don't.

## Webview host capabilities

The Tauri webview is still WKWebView, but the bridge coverage differs from the Swift
shell (`desktop/README.md` has the original checklist):

| Web behavior | How it's handled | Status |
|---|---|---|
| `<input type=file>` | wry implements the open panel natively | ✅ built-in |
| External link click | `on_navigation` → system browser (off-origin is cancelled) | ✅ wired |
| `target=_blank` / `window.open` | not used by the client (no handler wired) | ⬜ add if the client ever emits them |
| Downloads | `on_download` → auto-save to ~/Downloads + notification (no save panel: the hook runs on the main thread, and Chrome-style auto-save is the better default anyway) | ✅ wired |
| Web Notifications / Push | native, via the notification plugin | ✅ wired |
| `pantokenUpdate` JS bridge (early overlay raise) | not wired — the overlay raises on the updater's first apply event instead, ≤5s after the click | ⬜ optional follow-up |

## Not done yet

- Window frame persistence across launches (tauri-plugin-window-state, config'd to
  ignore visibility so close-to-tray doesn't restore hidden).
- The early-overlay JS bridge (table above).
- Tailnet binding (the server stays loopback-only; serving the phone from the desktop
  app is a separate decision with an auth story).
