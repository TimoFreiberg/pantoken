# Issue: Start a stable-port, authenticated Pantoken sidecar

## Context

`desktop/src/main.rs` currently calls `free_port()` and passes that value into `PantokenConfig`; `desktop/src/config.rs` always constructs a loopback environment without `PANTOKEN_TOKEN`; and `desktop/src/supervisor.rs` probes `/health` with a raw unauthenticated request. The Rust server already reads `PANTOKEN_HOST`, `PANTOKEN_PORT`, and `PANTOKEN_TOKEN`, and its WS path already has a hello-token concept. `desktop/src/updater.rs` also polls `/health` and posts `/update/state`, so adding auth only to external clients would break the shell's own update and active-turn safety contract.

This issue implements the startup and internal-auth half of the contract from `01-remote-contract.md`. It must leave local/dev mode behavior explicit and compatible.

## Goal

Make remote mode start `pantoken-server` on a persisted stable loopback port with a persistent Keychain token, enforce the documented HTTP/WS auth matrix, and ensure supervisor/updater internal calls authenticate and fail closed.

## Non-goals

- Building Settings/tray bootstrap UX or Tailscale Serve automation.
- Changing polytoken daemon behavior or adding a second server.
- Binding to a non-loopback interface.
- Replacing signed app updates or implementing the physical-device test suite.
- Silently falling back to a random port when remote mode cannot use its configured port.

## Dependencies

- Depends on `01-remote-contract.md` for configuration, bootstrap, Keychain, and auth decisions.
- Unblocks `03-phone-bootstrap.md`, `04-remote-app-updates.md`, and `05-mini-lifecycle.md`.

## Repository touch points and contracts

- `desktop/src/config.rs`: model remote/local mode, validate port, construct sidecar env, resolve Keychain token, preserve data-dir identity.
- `desktop/src/main.rs`: choose persisted remote port instead of unconditional `free_port()`, surface invalid/colliding-port failures before or during supervisor startup.
- `desktop/src/supervisor.rs`: add the bearer token to loopback `/health` and make auth/unavailable health false, never idle.
- `desktop/src/updater.rs`: add bearer auth to `/health` activity and `/update/state` report/poll requests; transport/auth failure must not produce `clients=0,busy=false` or apply an update.
- `desktop/src/state.rs`: preserve updater stop and teardown state.
- `server/pantoken-server/src/config.rs`, `main.rs`, `connection/*`: implement global or route-local enforcement as frozen by Issue 1.
- Existing server integration suites and new fake-sidecar/router seams: exercise HTTP, WS, auth, and failure paths.

### Required route matrix

The implementation issue is not complete until expected status/body and method behavior is recorded in tests for each row:

| Surface | Remote-mode contract | Local-mode compatibility |
|---|---|---|
| `/health` | Bearer-authenticated, unless a narrowly documented loopback-only exemption is proven unreachable through Serve; shell sends the bearer token | Existing no-token behavior remains where retained |
| Static fallback | Bearer-authenticated; only the documented `/bootstrap` path/window can be exempt | Existing local static behavior |
| `/ws` | Connection/hello requires the existing hello-token contract; missing/wrong credentials are rejected | Existing no-token/dev behavior |
| `/push/vapid`, `/push/subscribe`, `/push/unsubscribe`, `/push/test` | Bearer-authenticated | Existing local behavior |
| `/update/state` | Bearer-authenticated, including shell updater requests | Existing local behavior |
| `/debug/state`, `/debug/reset` | Bearer-authenticated and still gated to debug drivers | Existing debug gating plus local auth policy |

Tests must specify missing, malformed, and wrong bearer credentials; static fallback; `OPTIONS` and unsupported methods; WebSocket upgrade rejection; and hello rejection. Query-token auth is accepted only on the dedicated bootstrap path/window and is never emitted by normal client code afterward.

## Acceptance criteria

- **I2-AC.1 — Remote mode uses a stable configured port.** Enabling remote access causes every restart to start the sidecar on the persisted port, default `8787`; invalid values and an occupied port produce an actionable configuration/startup error; remote mode never silently randomizes the port.
- **I2-AC.2 — The sidecar remains loopback-only.** Remote startup passes `PANTOKEN_HOST=127.0.0.1` and does not bind `0.0.0.0`, a LAN address, or a Tailscale address. Tailscale Serve remains the documented exposure layer.
- **I2-AC.3 — Remote auth and internal shell auth are complete.** Remote mode supplies a non-empty token; the route matrix above is enforced; unauthenticated external requests fail; authenticated HTTP/WS/push requests succeed; supervisor `/health` and updater `/health`/`/update/state` calls carry `Authorization: Bearer <token>`; auth or health failure fails closed for liveness and update installation.
- **I2-AC.4 — Token lifecycle and bootstrap safety work.** A cryptographically random Keychain token is created on first enablement, persists across restart/app update, is never logged, supports revoke/regenerate, and integrates with one-time bootstrap expiry/replay, URL scrubbing, redacted logging, strict referrer policy, and post-bootstrap bearer headers. Keychain read/write failure prevents unauthenticated remote startup.
- **I2-AC.5 — Local behavior remains compatible.** Targeted tests prove retained random-port local behavior, omission of the remote token in local mode, existing local WS behavior, tray lifetime, supervisor health gating, and signed updater/service-worker separation are not regressed.

## Verification

- `desktop_config_remote_port_persists`: config unit tests for default, persistence, invalid range, and collision reporting.
- `desktop_sidecar_env_remote_mode`: environment-construction tests for remote/local host, port, token, data dir, client dist, and inherited environment boundaries.
- `remote_mode_forces_loopback_bind`: environment assertion plus a manual non-loopback socket check on a packaged Mini.
- `remote_mode_auth_required`: authenticated Axum/router integration fixture covering every route matrix row and exact failure responses.
- `unauthenticated_ws_rejected`: missing/wrong hello-token and upgrade tests.
- `authenticated_ws_and_push_allowed`: bearer-authenticated WS/push success tests.
- `supervisor_health_auth_contract`: fake sidecar captures the bearer header and treats 401, malformed responses, timeout, and connection failure as unhealthy.
- `updater_report_auth_contract`: fake server captures authenticated `/health` and `/update/state`; unavailable/auth-failed activity never becomes idle and never applies.
- `token_persistence_and_rotation`: Keychain create/read/revoke/regenerate and app-update persistence tests with failure injection.
- `bootstrap_expiry_replay`: one-time credential expiration/reuse and ordinary-route query-token rejection tests.
- `local_mode_keeps_random_port`, `local_mode_omits_remote_token`, `tray_close_keeps_supervisor_alive`, `updater_does_not_apply_while_busy`, `pwa_sw_update_is_separate_from_apply_update`: targeted regressions.

## Criterion-to-verification map

| Criterion | Verification IDs |
|---|---|
| `I2-AC.1` | `desktop_config_remote_port_persists`, `desktop_sidecar_env_remote_mode` |
| `I2-AC.2` | `remote_mode_forces_loopback_bind` |
| `I2-AC.3` | `remote_mode_auth_required`, `unauthenticated_ws_rejected`, `authenticated_ws_and_push_allowed`, `supervisor_health_auth_contract`, `updater_report_auth_contract` |
| `I2-AC.4` | `token_persistence_and_rotation`, `bootstrap_expiry_replay` |
| `I2-AC.5` | `local_mode_keeps_random_port`, `local_mode_omits_remote_token`, `tray_close_keeps_supervisor_alive`, `updater_does_not_apply_while_busy`, `pwa_sw_update_is_separate_from_apply_update` |

## Documentation and manual requirements

Record the route matrix, status/body semantics, token storage names, port collision behavior, and internal shell auth in `desktop/README.md` or the selected design document. A signed packaged app must be checked manually for the actual listening socket and restart persistence. Do not put real tokens in fixtures, logs, screenshots, or issue comments.

## Risks and follow-up decisions

- Raw std-only supervisor HTTP needs a test seam that can assert headers without making production code depend on a full client runtime.
- Server middleware ordering can accidentally leave static fallback or `OPTIONS` unauthenticated; tests must cover those paths explicitly.
- Health failures must be conservative: treating an unreachable hub as idle could interrupt a turn during an updater race.
- Port validation and Keychain failure should be user-visible and actionable, not just logged.
