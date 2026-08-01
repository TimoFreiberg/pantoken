# Issue: Freeze the Mac Mini remote-access contract and configuration model

## Context

Pantoken.app is a Tauri macOS shell around the bundled `pantoken-server`. The shell currently chooses a free loopback port at startup, forces `PANTOKEN_HOST=127.0.0.1`, and starts the server without `PANTOKEN_TOKEN`. The server already accepts configurable host/port/token values, while the client already captures a `?token=` URL value into local storage and scrubs it from the address bar. Those pieces are useful primitives, but the product contract for an always-on Mac Mini hub is not yet frozen.

The supported deployment for this issue set is an installed iPhone PWA reaching Pantoken.app over private HTTPS provided by Tailscale Serve. Tailscale proxies to a server that remains bound to `127.0.0.1:<stable-port>` on the Mac Mini. The phone must not require a second backend, direct port forwarding, a public Funnel, or a native mobile wrapper.

This issue is the contract authority for later implementation issues. It should be resolved before changing startup, auth middleware, or UX so that those changes share one security and persistence model.

## Goal

Freeze an implementable v1 contract for remote access, persistent configuration, bootstrap, token storage, and opt-in Mac startup. Record the decisions in the repository's appropriate design/ADR location during the later implementation work.

## Non-goals

- Implementing the server, desktop shell, client, or updater changes in this issue.
- Building a native iOS/Android wrapper or a mobile-only backend.
- Automatically discovering or mutating Tailscale configuration.
- Exposing the hub on `0.0.0.0`, a LAN address, or a Tailscale interface.
- Replacing the existing signed `.app` updater with a PWA update mechanism.
- Introducing a private app-data token fallback in parallel with Keychain for v1.

## Dependencies

- None. This issue is the contract prerequisite for `02-authenticated-sidecar.md`, `03-phone-bootstrap.md`, `04-remote-app-updates.md`, and `05-mini-lifecycle.md`.

## Repository touch points and contracts

- `desktop/src/config.rs`, `desktop/src/main.rs`: define the persisted remote-mode settings and startup decision boundary.
- `desktop/src/state.rs`: retain configuration and lifecycle state without changing session/data ownership semantics.
- `server/pantoken-server/src/config.rs`, `main.rs`: consume the eventual host/port/token contract.
- `client/src/lib/auth.ts`, `client/src/lib/store.svelte.ts`: align browser bootstrap and bearer-header behavior with the contract.
- `protocol/src/wire.ts`: keep `applyUpdate`/`updateStatus` distinct from service-worker refreshes.
- `README.md`, `desktop/README.md`, `docs/DESIGN.md`, `docs/PLAN-mobile.md`: become consistent with the chosen topology; stale `deploy/` references and protocol-version claims must be reconciled as part of the later documentation issue.

The persisted remote configuration must define at least:

- `enabled` (remote access off/on);
- stable hub port, default `8787`;
- Keychain token reference and lifecycle state, without putting a stale token in a phone URL or ordinary diagnostics;
- explicit user-provided HTTPS origin, normalized without silently guessing a hostname;
- enough non-secret endpoint metadata to display and verify the configured origin.

The contract must preserve random loopback-port behavior for local-only mode unless implementation tests and UX demonstrate a deliberate change. Remote mode is deterministic across restarts and fails closed when its token cannot be loaded.

### Bootstrap contract to freeze

Choose one dedicated path, preferably `/bootstrap`, and one documented setup window. Specify all of the following before implementation:

1. credential type: a short-lived, one-time bootstrap credential exchanged for the persistent app token is preferred; if the app token itself is used, document that tradeoff explicitly;
2. allowed HTTP method and exact success response/body behavior;
3. expiry, one-time consumption, replay rejection, and stable unauthorized response;
4. immediate history/address-bar scrubbing and subsequent `Authorization: Bearer` use;
5. strict `Referrer-Policy` and redacted request/access logs;
6. rejection of query-token authentication on ordinary static, API, and WebSocket routes.

### Security and startup decisions

- Remote mode always requires a non-empty cryptographically random token.
- The server always binds to `127.0.0.1`; Tailscale Serve is the only documented network-facing layer.
- v1 token storage is macOS Keychain. Define service/account names, first creation, read/write failure (remote startup fails closed), revoke/regenerate, and any migration from a pre-release file token.
- v1 launch-at-login is opt-in macOS Service Management through `SMAppService.mainApp`. Define the registration identifier, enable/disable, uninstall and app-update behavior, failure status, Tauri/macOS integration boundary, bundle metadata/helper configuration, and manual packaging checks. A user-managed Login Item or launch agent may be documented only as a fallback explanation, not as implementation acceptance.

## Acceptance criteria

- **I1-AC.1 — Supported topology is explicit.** The design/ADR contract describes the installed iPhone PWA → private HTTPS/Tailscale Serve → localhost proxy → Pantoken.app → supervised `pantoken-server` topology, explicitly states the loopback bind boundary, and distinguishes PWA service-worker updates from signed `.app` updates. It contains no instruction to expose the hub directly or run a second mobile backend.
- **I1-AC.2 — Remote configuration is deterministic and safe.** The contract specifies enabled state, default port `8787`, explicit HTTPS origin, token reference, persistence boundaries, local-only compatibility, and fail-closed behavior when the remote token is unavailable.
- **I1-AC.3 — Bootstrap and lifecycle decisions are testable.** The contract freezes the dedicated bootstrap path/window, credential type, method, expiry/replay behavior, URL scrubbing, query-token restrictions, Keychain policy, and opt-in `SMAppService.mainApp` startup behavior sufficiently for later issues to implement without reopening these decisions.
- **I1-AC.4 — Documentation discrepancies have owners.** The implementation handoff identifies how `deploy/` references and stale protocol-version claims will be removed or corrected, and assigns final deployment/runbook cleanup to `06-validation-and-docs.md`.

## Verification

- `remote_access_architecture_docs`: standalone review of the ADR/design section against the topology and security contract.
- `remote_contract_config_matrix`: table-driven review proving every required persisted field has a default, owner, migration/failure behavior, and local-vs-remote rule.
- `bootstrap_contract_review`: checklist covering method, credential lifetime, replay, URL scrubbing, headers, referrer policy, and query-token route restrictions.
- `startup_registration_packaging_review`: manual review of `SMAppService.mainApp` identifier, bundle/helper metadata, enable/disable/uninstall/update behavior, and failure reporting.
- `stale_deployment_and_protocol_search`: read-only search for contradictory `deploy/` and protocol-version statements, with each result classified for the later docs issue.

## Criterion-to-verification map

| Criterion | Verification IDs |
|---|---|
| `I1-AC.1` | `remote_access_architecture_docs`, `stale_deployment_and_protocol_search` |
| `I1-AC.2` | `remote_contract_config_matrix` |
| `I1-AC.3` | `bootstrap_contract_review`, `startup_registration_packaging_review` |
| `I1-AC.4` | `stale_deployment_and_protocol_search` |

## Documentation and manual requirements

The later implementation must update the design/ADR and the Mini runbook with the selected contract. Packaging verification must be performed on a signed macOS app, including first launch, update, uninstall, and launch-at-login registration status. No Tailscale CLI mutation is required for this issue.

## Risks and follow-up decisions

- Keychain APIs and Tauri packaging may require a narrow macOS-only integration boundary; do not silently substitute a file token.
- A query bootstrap URL has residual exposure in browser history, referrers, and intermediary logs; all mitigations and the remaining exposure window must be explicit.
- A fixed port can collide. Remote mode must report a clear collision/configuration error rather than silently selecting a random port.
- If a short-lived bootstrap credential cannot be implemented in the first slice, the app-token alternative must be a separately documented and tested decision, not an implicit compromise.
