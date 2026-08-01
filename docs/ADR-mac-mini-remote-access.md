# ADR: Mac Mini remote access through a private Tailscale Serve

- **Status:** Accepted v1 contract
- **Date:** 2026-08-01
- **Scope:** The installed Pantoken.app on a macOS Mac Mini, and an installed iPhone PWA used by the same single user.
- **Source of truth:** This ADR is the authoritative protocol and persistence contract for Issues 2–6 in `docs/issues/mobile-access/`.
- **Dependencies:** None. `02-authenticated-sidecar.md`, `03-phone-bootstrap.md`, `04-remote-app-updates.md`, and `05-mini-lifecycle.md` consume this contract without reopening these decisions. `06-validation-and-docs.md` owns repository-wide reconciliation and the Mini runbook.

## Decision summary

Remote access is opt-in. The supported v1 path is an installed iPhone PWA over a private HTTPS Tailscale Serve origin, with Serve proxying to the bundled `pantoken-server` supervised by Pantoken.app. The server listens only on `127.0.0.1:<stable-port>` on the Mac Mini. Pantoken does not discover, configure, or mutate Tailscale.

Remote mode uses a persisted port (8787 by default), an explicitly entered HTTPS origin, and a bearer token kept only in macOS Keychain. A one-time, short-lived bootstrap credential is exchanged at `/bootstrap` for that persistent token. Any unavailable or ambiguous security prerequisite fails closed with an actionable status; the app never silently randomizes a remote port, binds a non-loopback interface, or falls back to a file token.

This issue records documentation and contract only. It does not implement server routes, desktop settings, client bootstrap UI, updater behavior, Keychain calls, Service Management registration, or Tailscale changes.

## Supported topology and security boundary

```text
  installed iPhone PWA (HTTPS)
              |
              | private tailnet; user-configured Tailscale Serve origin
              v
  Tailscale Serve (only network-facing layer; no Funnel)
              |
              | proxy target: 127.0.0.1:<stable-port>
              v
  Pantoken.app on Mac Mini
    └─ supervises bundled pantoken-server
         ├─ binds only 127.0.0.1:<stable-port>
         ├─ serves the bundled PWA assets
         └─ drives local polytoken daemons and durable sessions
```

The installed iPhone PWA is the remote UI. Tailscale Serve is a private HTTPS proxy, not a second application server. Pantoken.app supervises the bundled `pantoken-server`; it does not start a separate mobile backend. The v1 boundary explicitly prohibits direct port forwarding, Tailscale/LAN binding, `0.0.0.0`, Funnel, public exposure, and an independently deployed server.

The user supplies and confirms the HTTPS Tailscale Serve origin. Pantoken stores and verifies the origin metadata but never infers a hostname from Tailscale, auto-discovers a tailnet, or changes Tailscale configuration. Serve must target the persisted local port. A target mismatch, occupied port, malformed origin, or unavailable hub is an actionable error rather than a fallback.

The desktop window and the phone PWA are two clients of the same supervised hub. The existing desktop-initiated SSH/provisioning path remains a separate **desktop remote-target mode**: it can provision a `pantoken-server` on another host and bridge the local desktop to that host. Its historical architecture notes do not describe Mac Mini phone access and must not be read as permission for a public or second backend. The qualification is recorded in `DESIGN.md` and `DECISIONS.md` and the final repository-wide cleanup belongs to Issue 06.

### Update boundary

A PWA service-worker/client refresh is distinct from a signed Pantoken `.app` update. The signed `.app` artifact atomically updates the shell, bundled server, and bundled client; it does not turn Tailscale Serve into an updater or replace the app updater with a PWA mechanism. A service-worker update may refresh web assets independently, while a signed app update is the authority for shell/server/client compatibility and restart behavior.

## Scope and non-goals

This ADR freezes the v1 behavior needed by the later implementation issues. It does not implement:

- server, desktop, client, updater, or Tailscale changes;
- a native iOS/Android wrapper, account system, multi-tenant service, or mobile-only backend;
- automatic Tailscale discovery or mutation;
- direct exposure on a LAN/Tailscale interface, `0.0.0.0`, port forwarding, Funnel, or a public URL;
- a file-token fallback for Keychain;
- launch-agent/helper fallback as a v1 launch-at-login implementation;
- runtime Keychain, signed-package, physical iPhone, Tailscale, bootstrap-router, or product regression tests.

Those runtime and platform checks are follow-up verification owned by Issues 2–6, with repository reconciliation owned by `docs/issues/mobile-access/06-validation-and-docs.md`.

## Persisted remote configuration

### Storage boundary and migration

Ordinary remote settings live at:

```text
~/Library/Application Support/Pantoken/remote-access.json
```

This file has schema version **1**. It is separate from both the server data directory and the existing `remote-profiles.json`. It contains no bearer token and no bootstrap credential. Replacement is atomic: write a validated temporary file in the same directory, flush/close it according to the platform implementation, then rename it into place. A failed write, flush, rename, or parent-directory operation leaves the last known good file in place and reports an actionable error; it must not partially apply settings.

An absent file means the v1 defaults (`enabled=false`, `hub_port=8787`, no origin, and a `missing` Keychain reference). Malformed or unreadable JSON is not silently replaced with defaults when remote access was previously configured: status is actionable and remote availability is disabled until the user repairs or resets the settings. A first-run absent file is safe because remote access is disabled.

Settings migration is not server data-directory migration. The existing server migration (for example, the pre-0.6 XDG state-to-data move) remains server-owned. Reading or rewriting `remote-access.json` must not invoke, alter, delete, or move sessions, transcripts, VAPID state, archive indexes, pidlocks, or any other server data. Changing remote settings never deletes or migrates Pantoken sessions or ordinary app data.

### v1 configuration matrix

Every field has an explicit owner, migration, failure behavior, and local-versus-remote rule:

| Field | Type / default | Owner and storage boundary | Migration | Failure behavior | Local vs remote rule |
|---|---|---|---|---|---|
| `schema_version` | integer; `1` | Pantoken.app settings reader; `remote-access.json` | Absent file gets schema 1. Unknown or unsupported versions require an explicit migration before use. | Malformed, unknown, or unreadable schema is actionable and remote access fails closed. | Applies to remote settings only; never changes server data migration. |
| `enabled` | boolean; `false` | Pantoken.app lifecycle/config owner; ordinary settings file | Missing means false. | A non-boolean is malformed; do not guess. | `false` stops remote availability but preserves sessions/data and retains settings. `true` enables the fixed-port/authenticated path only after all prerequisites validate. |
| `hub_port` | unsigned 16-bit integer; `8787` in remote mode | Pantoken.app startup owner; ordinary settings file | Missing means 8787. Existing local random-port behavior is not migrated into a remote fixed port without explicit enablement. | In remote mode only `1024..=65535` is valid. `0`, privileged ports, out-of-range values, and occupied ports are actionable startup errors; never silently randomize. | Remote mode persists and uses this exact port. Local-only mode retains random loopback selection, including the existing `:0` mechanism, and does not require this field to be used. |
| `origin` | HTTPS URL string; absent until configured | Pantoken.app endpoint owner; ordinary settings file | Missing is allowed while disabled. Enabling requires explicit user entry and confirmation. | Reject non-HTTPS, userinfo, query, fragment, ambiguous host input, empty host, or unsafe syntax. Do not infer a Tailscale hostname. | Required when enabled. Normalize only safe syntax such as one trailing slash; use the normalized origin for endpoint checks and display. |
| `endpoint_metadata` | object: normalized origin/display host, verification state, last verification timestamp, redacted failure reason; absent/empty by default | Pantoken.app status owner; ordinary settings file | Recompute or clear stale verification state when origin changes; timestamps use an unambiguous serialized format. | Metadata parse failure is actionable; a failed check never reports verified. Failure reasons are redacted and contain no token/credential. | Non-secret status for the configured remote origin. It does not authorize requests and is not stored in server data. |
| `keychain_token` | object reference: service `dev.pantoken.app.remote-access`, account `bearer-token`, lifecycle `missing` / `available` / `unavailable` / `revoked`; default `missing` | macOS Keychain owns the secret; settings file stores only the reference and lifecycle state | A missing reference triggers first-enable creation. Legacy file-token migration is explicit only; never silently consume it. | Keychain read/write/create failure sets `unavailable`, reports an actionable status, and refuses remote startup. No file fallback. | Required whenever enabled. Local-only mode has no remote token requirement. The token value never appears in this file. |

When remote mode is enabled, startup forces `PANTOKEN_HOST=127.0.0.1`, passes the persisted `hub_port`, and supplies the Keychain bearer token to the supervised bundled server without logging it. When disabled, the existing local-only behavior remains compatible: the server stays loopback-only, its port may be selected randomly using `:0`, and no remote token is required. A fixed remote-port collision or invalid setting is never converted into local random-port behavior.

## Token and Keychain lifecycle

On first remote enablement Pantoken generates at least 32 cryptographically random bytes and encodes them in a transport-safe representation. It stores the resulting bearer token only in macOS Keychain with:

- service: `dev.pantoken.app.remote-access`;
- account: `bearer-token`.

The ordinary settings file stores only that reference and its lifecycle state. Pantoken passes the secret to the supervised server through the narrow startup boundary and never writes it to logs, request/access logs, endpoint metadata, screenshots, crash text, or ordinary diagnostics.

A Keychain read, write, create, or availability failure refuses remote startup and presents a status that tells the user to unlock/repair Keychain or retry. There is no app-data, `remote-access.json`, environment-file, or other file fallback. If the token is revoked or regenerated, the old bearer token and all outstanding bootstrap credentials are invalidated first; a new random token is created and stored, while sessions and ordinary app data are preserved.

A pre-release file-token migration is never implicit. An explicit migration action may read a non-empty legacy value, write it to the specified Keychain item, and delete the legacy secret only after the Keychain write succeeds. The value is redacted from diagnostics throughout. If migration fails, the legacy value remains for a deliberate retry but remote mode remains unavailable; it is never used silently as an authentication fallback.

After bootstrap, the opaque setup credential and persistent token must not remain in phone URLs, browser history, referrers, request/access logs, server logs, endpoint metadata, screenshots, or ordinary diagnostics. The persistent bearer token is sent only as `Authorization: Bearer <token>` after the exchange.

## `/bootstrap` exchange contract

### Setup window and state machine

Pantoken exposes one dedicated bootstrap setup window at the explicitly configured origin. The setup link is:

```http
GET /bootstrap?credential=<opaque-one-time-value>
```

The credential is cryptographically random, expires exactly 10 minutes after issuance, is held only for that setup window, and is atomically consumed on successful exchange. It is not the persistent bearer token.

The route state machine is:

```text
issued, unexpired, unconsumed
  ├─ valid GET  -> 200 minimal HTML exchange page
  ├─ invalid GET/missing/expired/consumed/wrong -> 401 JSON unauthorized
  └─ valid POST from page -> atomically consume -> 200 JSON token
invalid POST/missing/malformed/expired/consumed/wrong -> 401 JSON unauthorized
any other method -> 405 JSON method_not_allowed, Allow: GET, POST
```

### Exact HTTP behavior

- A valid credential on the initial `GET /bootstrap` during the setup window returns **HTTP 200**, `Content-Type: text/html`, and a minimal exchange page. It includes `Cache-Control: no-store, no-cache, must-revalidate`, an equivalent cache-prevention policy as appropriate, and `Referrer-Policy: no-referrer`.
- A missing, malformed, expired, consumed, or wrong credential on the initial GET returns the same **HTTP 401**, `Content-Type: application/json`, exact body `{ "error": "unauthorized" }`. The response does not distinguish replay from expiry and does not authenticate any ordinary app route.
- Every method other than GET and POST returns **HTTP 405**, `Content-Type: application/json`, exact body `{ "error": "method_not_allowed" }`, and `Allow: GET, POST`.
- The setup page immediately copies the query credential into ephemeral page memory, removes it from the visible URL and history with `history.replaceState`, and never puts it in the POST URL, browser storage, or any subsequent navigation. It applies `Referrer-Policy: no-referrer` and no-store/cache-prevention headers before submitting the exchange.
- The page submits **`POST /bootstrap`** with `Content-Type: application/json` and exactly `{ "credential": "..." }` as the JSON body.
- A valid POST returns **HTTP 200**, `Content-Type: application/json`, exact body `{ "token": "<persistent-bearer-token>" }`, and no-store/cache-prevention headers. The client stores the persistent token in its designated local credential store, scrubs the URL before follow-up navigation, and sends `Authorization: Bearer <token>` thereafter.
- Invalid POST credentials, including missing, malformed, expired, consumed, and wrong values, all return the same stable **HTTP 401**, `Content-Type: application/json`, exact body `{ "error": "unauthorized" }`; they do not distinguish replay or expiry.

Only the documented bootstrap GET/POST behavior can observe the setup credential. Query-token authentication is rejected on every ordinary static, API, push, update, debug, and WebSocket route. Normal client requests never send credentials in a query string. Request/access logging must redact the query credential, JSON credential, and bearer header before any sink or diagnostic formatter sees them.

The initial query URL has unavoidable residual exposure while it is first opened: browser history, copied URLs, intermediary request metadata, or a misconfigured referrer could observe it. The contract limits that window with immediate `history.replaceState`, no browser storage for the setup credential, `Referrer-Policy: no-referrer`, no-store/cache-prevention headers, redacted logs, ten-minute expiry, and atomic one-time consumption. These mitigations do not justify accepting query credentials on ordinary routes.

## Opt-in macOS launch-at-login and packaging

Launch-at-login is an opt-in integration behind a small macOS-only target-gated boundary around `SMAppService.mainApp`. The registration identity is the existing bundle identifier `dev.pantoken.app`; v1 has no separate helper.

- **Enable:** call `SMAppService.mainApp.register()` and persist/report the resulting registration state.
- **Disable:** call `SMAppService.mainApp.unregister()` and report the resulting state.
- **Status:** read the Service Management status API; do not infer status from a preference or a successful previous click.
- **Launch behavior:** a registered login launch starts Pantoken.app and the supervised bundled hub without requiring a visible window. Closing the main window leaves the tray, supervisor, and remote service alive. Explicit Quit performs normal teardown and makes the endpoint unavailable.
- **Failure:** registration failures are visible and actionable. Pantoken does not silently substitute a launch agent, a user Login Item, or a helper. Those may be documented as manual fallback explanations only; they are not v1 implementation acceptance.
- **Update:** a signed update with the same `dev.pantoken.app` bundle identity preserves the registration. The atomically updated shell + server + client continues to use the same supervised endpoint contract.
- **Uninstall:** uninstall removes the app's registration and availability. Signed packaging checks must verify enable, disable, update preservation, uninstall removal, and endpoint teardown.
- **Build boundary:** Tauri commands call a narrow Rust integration boundary; macOS-only Service Management calls remain target-gated. Bundle metadata is verified in `desktop/tauri.conf.json`, generated `Info.plist`, or the eventual helper configuration. Development and unsigned behavior are not release acceptance.

This issue does not add lifecycle implementation. Later lifecycle work must preserve the existing distinction between closing a window and explicit Quit, and must not broaden the scope into unrelated desktop lifecycle behavior.

## Ownership and handoff

The following later issue artifacts consume this ADR without reopening its topology, persistence, bootstrap, Keychain, or launch-at-login decisions:

| Consumer | What it may implement | Contract authority |
|---|---|---|
| `docs/issues/mobile-access/02-authenticated-sidecar.md` | Stable loopback sidecar, auth middleware, supervisor/internal auth | This ADR, especially configuration, token, and route restrictions |
| `docs/issues/mobile-access/03-phone-bootstrap.md` | Origin UX, bootstrap/revoke UX, endpoint status | This ADR, especially the exact `/bootstrap` state machine |
| `docs/issues/mobile-access/04-remote-app-updates.md` | Authenticated staged signed app updates and active-turn safety | This ADR, especially app/PWA update separation |
| `docs/issues/mobile-access/05-mini-lifecycle.md` | Service Management integration, tray/Quit behavior, recovery | This ADR, especially `SMAppService.mainApp` and packaging rules |
| `docs/issues/mobile-access/06-validation-and-docs.md` | Hermetic/device/tailnet validation, final documentation cleanup, Mini runbook | This ADR plus the inventory below; it must not weaken the private topology |

## Stale deployment and protocol inventory

This is a read-only inventory captured for this ADR, not a broad cleanup. The tracked search scope is exactly: `README.md`, `desktop/README.md`, `docs/DESIGN.md`, `docs/DECISIONS.md`, `docs/PLAN-mobile.md`, `docs/issues/mobile-access/*.md`, and any `deploy/**` files. The search terms are `deploy/`, `?token=`, `PROTOCOL_VERSION`, `protocol version`, `protocol-version`, daemon compatibility/version claims, and direct-exposure/second-backend language.

The inventory deliberately distinguishes authoritative current protocol constants and compatibility claims from stale deployment claims. A historical/qualified row is not an instruction for the Mac Mini PWA topology. Every contradictory deployment/protocol row assigns final correction/removal and the Mini runbook to `docs/issues/mobile-access/06-validation-and-docs.md`.

| File/line or stable heading | Matched claim | Classification | Rationale | Owner/action |
|---|---|---|---|---|
| `README.md`, Architecture / Remote development paragraph | The desktop provisions `pantoken-server` on a remote host over SSH and says there is no standalone server deployment. | historical/qualified | This is the desktop-initiated remote-target mode, not the installed iPhone PWA → Serve → localhost mode. | Issue 06: qualify the README and link this ADR; do not remove the desktop-target history prematurely. |
| `desktop/README.md`, “How it works” and “Not done yet” | The desktop picks a free loopback port and says tailnet binding is a separate future decision. | historical/qualified | Describes current local-only behavior and pre-contract implementation state; remote mode will later add a separate fixed-port branch. | Issue 06: reconcile the README after implementation; no product change here. |
| `docs/DESIGN.md`, Architecture diagram and paragraphs around “single entry point” | SSH/provisioning and “no standalone server deployment” are broad enough to be mistaken for the only remote topology. | historical/qualified | Desktop remote-target mode remains valid, but must be explicitly scoped away from private phone access. | Issue 06: retain history while ensuring the supported Mac Mini subsection and ADR are unambiguous. |
| `docs/PLAN-mobile.md`, Distribution & updates and checklist | `https://<mini>.<tailnet>.ts.net/?token=…`, `deploy/DEPLOY.md`, and blue-green deploy are presented as the mobile path. | contradictory | This conflicts with the one-time `/bootstrap` exchange, explicit origin contract, and bundled-app supervision. | `docs/issues/mobile-access/06-validation-and-docs.md`: correct/remove the stale `deploy/` and query-token runbook claims and reconcile the Mini runbook. |
| `docs/PLAN-mobile.md`, implementation table | `deploy/` is listed as the working Tailscale/token/TLS/blue-green deployment. | contradictory | v1 does not document a deploy directory, direct deployment, or file/query-token scheme as the Pantoken.app path. | `docs/issues/mobile-access/06-validation-and-docs.md`: assign final correction/removal and runbook ownership here. |
| `docs/DECISIONS.md`, “Remote deployment: version source = codegen-time polytoken --version” | Installed daemon `0.5.8` and the codegen compatibility floor are discussed. | historical/qualified | This is an authoritative compatibility decision for the desktop remote-target/deployment subsystem, not a Mac Mini network exposure claim. | Issue 06: keep current constants accurate and link this ADR where scope could be confused. |
| `docs/DESIGN.md`, Protocol / Release manifest sections | `PROTOCOL_VERSION` is currently `5`; release manifests validate protocol version against it. | authoritative current | These are current application protocol/release-manifest constants and must not be “fixed” as stale deployment text. | Issue 06: verify against code during final docs cleanup; do not change in Issue 1. |
| `docs/DECISIONS.md`, Remote deployment manifest decision | The release manifest uses `PROTOCOL_VERSION` and separates Pantoken identity from the daemon compatibility floor. | authoritative current | This is an explicit compatibility boundary, not a second backend or public deployment instruction. | Issue 06: preserve, cross-link, and audit only as part of final docs reconciliation. |
| `docs/issues/mobile-access/01-remote-contract.md`, Context / touch points | The issue says the current client captures `?token=` and names stale `deploy/` and protocol claims. | historical/qualified | It records pre-contract facts and the cleanup dependency; this ADR supersedes the proposed implementation behavior. | Issue 06: update issue-set cross-references only if needed; this ADR is the implementation authority. |
| `docs/issues/mobile-access/06-validation-and-docs.md`, I6-AC.3 and touch points | Final docs must contain no contradictory direct-exposure, second-backend, stale `deploy/`, or protocol-version claims. | historical/qualified | This is the explicit future cleanup owner, not a product deployment instruction. | Issue 06: execute the repository-wide search, classification, corrections, and Mini runbook. |
| `deploy/**`, if present in the tracked checkout | Any deploy script/runbook that binds publicly, uses `?token=`, or claims a separate mobile backend. | contradictory | Such instructions would violate the private Serve/loopback boundary and the bootstrap contract. | `docs/issues/mobile-access/06-validation-and-docs.md`: inspect every tracked row, remove or qualify it, and reconcile the Mini runbook; no broad cleanup in Issue 1. |

### Inventory acceptance and follow-up

The deterministic documentation check `stale_deployment_and_protocol_search` must verify the stated tracked scope, all search terms, the inventory columns (file/line or stable heading, matched claim, classification, rationale, owner/action), both classification vocabulary values, the authoritative-versus-stale distinction, and an Issue 06 owner on every contradictory deployment/protocol row. The final repository-wide search and any correction/removal are intentionally deferred to `docs/issues/mobile-access/06-validation-and-docs.md`.

## Acceptance criteria and verification map

| Acceptance criterion | Observable verification |
|---|---|
| AC.1 supported topology | `remote_access_architecture_docs`: inspect this ADR and the linked DESIGN/DECISIONS sections for PWA → private Serve → localhost → Pantoken.app → bundled server, loopback-only binding, no direct exposure/second backend, and PWA-vs-`.app` update separation. |
| AC.2 deterministic configuration | `remote_contract_config_matrix`: check every matrix field for type/default/owner/storage/migration/failure/local-vs-remote rules, including fixed-port collision and Keychain fail-closed behavior. |
| AC.3 implementable bootstrap/lifecycle | `bootstrap_contract_review` and `startup_registration_packaging_review`: check exact route responses, expiry/replay/scrubbing/redaction/query restrictions, Keychain policy, Service Management calls/status, close-versus-Quit, signed update, uninstall, and failure semantics. |
| AC.4 discrepancy ownership | `stale_deployment_and_protocol_search`: check the read-only tracked-scope inventory, classifications, authoritative distinction, and Issue 06 ownership for every contradictory row. |

Validation for this issue is limited to the read-only documentation/link/search test described above. Physical signed-app packaging, Keychain runtime, bootstrap integration, route/auth, Tailscale Serve, and product implementation tests remain follow-up work and are not claimed as complete.
