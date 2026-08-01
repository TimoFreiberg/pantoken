# Issue: Add explicit phone bootstrap and remote-access UX

## Context

The client already has token capture in `client/src/lib/auth.ts` and a desktop/mobile Settings surface in `client/src/components/Settings.svelte`, but the current flow assumes a user knows a token URL and does not represent Mac Mini endpoint health. A usable phone path needs an explicit HTTPS origin, a safe one-time bootstrap flow, revocation, and narrow-layout controls. Tailscale Serve must remain an explicit private setup step rather than an app-managed public exposure mechanism.

This issue owns the user-facing setup after the authenticated sidecar exists. It does not redefine the server auth contract from `01-remote-contract.md` or `02-authenticated-sidecar.md`.

## Goal

Let a Mini user enable phone access, configure and verify an explicit HTTPS tailnet origin, bootstrap one or more phones safely, revoke a lost link without deleting sessions, and understand endpoint/authentication failures.

## Non-goals

- Automatic Tailscale installation, hostname discovery, or CLI mutation as a v1 prerequisite.
- Tailscale Funnel, router port forwarding, direct public port exposure, or Cloudflare/VPS deployment.
- Native mobile packaging.
- Storing bearer tokens in logs, ordinary diagnostics, or permanent URLs.
- Deleting Pantoken session data when phone access is disabled or revoked.

## Dependencies

- Depends on `01-remote-contract.md` for the explicit-origin, bootstrap, Keychain, and private-topology decisions.
- Depends on `02-authenticated-sidecar.md` for stable port, route auth, token rotation, and bootstrap endpoint behavior.
- `04-remote-app-updates.md` consumes the authenticated phone connection and status UX.

## Repository touch points and contracts

- `client/src/lib/auth.ts`: use the dedicated bootstrap path, persist token state, immediately replace history, and use Authorization headers afterward.
- `client/src/lib/store.svelte.ts`: expose endpoint/auth status, reconnect, revoke-related state, and redacted diagnostics.
- `client/src/components/Settings.svelte`, `Sidebar.svelte`, and shared UI primitives: add desktop Settings/tray handoff and narrow/mobile controls.
- `desktop/src/config.rs`/`main.rs`/state: persist enabled state, port, explicit origin, and non-secret status metadata.
- `server/pantoken-server/src/main.rs` and static/auth layers: expose the dedicated bootstrap and endpoint verification behavior.
- `desktop/README.md` and the Mini runbook: document manual Tailscale Serve setup and troubleshooting.

### Required UX states

The UI must distinguish, without revealing secrets:

- remote access disabled;
- token not configured or Keychain unavailable;
- Tailscale not installed/disconnected when determinable, otherwise endpoint-unverified;
- Serve endpoint not configured/unverified;
- configured origin points at the wrong target;
- hub unavailable;
- authentication failure;
- verified and ready.

For v1, the user enters an HTTPS origin such as `https://mini.<tailnet>.ts.net/`. The UI may display/copy that origin plus a one-time bootstrap URL and optionally render a QR code, but must not place a persistent app token in logs or ordinary diagnostics. Revoke/regenerate invalidates the old phone link while leaving sessions intact.

## Acceptance criteria

- **I3-AC.1 — Phone bootstrap is explicit and recoverable.** Settings/tray lets the user enable/disable phone access, view the configured port, enter the HTTPS origin, generate/copy a one-time bootstrap link, and revoke/regenerate access without deleting sessions. The phone stores the credential, scrubs the URL/history immediately, and uses bearer headers for subsequent requests.
- **I3-AC.2 — Tailscale exposure is private by default.** The documented and tested setup uses Tailscale Serve/private tailnet access to proxy localhost; no router forwarding or Funnel is required. Any future app-managed action requires explicit confirmation and cannot create public exposure silently.
- **I3-AC.3 — Endpoint status is actionable and mobile-safe.** The UI distinguishes disabled, missing token, endpoint-unverified, wrong-target, hub-unavailable, auth-failure, and ready states; sensitive values are redacted; all phone-path controls remain usable in the narrow/mobile layout.

## Verification

- `phone_bootstrap_flow`: Playwright/client integration scenario for link generation, first load, credential capture, immediate URL/history scrubbing, bearer-header follow-up, expiry/replay errors, and reconnect.
- `token_query_route_restrictions`: server integration assertions that query tokens work only for the documented bootstrap path/window and are rejected elsewhere.
- `endpoint_status_matrix`: deterministic fake endpoint tests for each status state, including wrong target versus hub unavailable versus auth failure.
- `tailscale_setup_docs_private_only`: documentation review and command-text search proving Serve/private tailnet is the only supported exposure and Funnel/direct port forwarding are not required.
- `MINI-SETUP-01`: install/verify Tailscale on the Mini and establish private tailnet membership.
- `MINI-SETUP-02`: configure Tailscale Serve manually to proxy the documented localhost port.
- `MINI-SETUP-03`: enter the exact HTTPS origin in Pantoken.app and run the authenticated verification request.
- `MINI-SETUP-04`: bootstrap an iPhone, confirm URL scrubbing and token persistence after relaunch.
- `MINI-SETUP-05`: revoke/regenerate access and confirm the old phone link fails while sessions remain.
- `MINI-SETUP-06`: exercise wrong-target, disconnected/unverified, hub-unavailable, and auth-failure messages.

## Criterion-to-verification map

| Criterion | Verification IDs |
|---|---|
| `I3-AC.1` | `phone_bootstrap_flow`, `token_query_route_restrictions`, `MINI-SETUP-03`, `MINI-SETUP-04`, `MINI-SETUP-05` |
| `I3-AC.2` | `tailscale_setup_docs_private_only`, `MINI-SETUP-01`, `MINI-SETUP-02` |
| `I3-AC.3` | `endpoint_status_matrix`, `MINI-SETUP-06` |

## Documentation and manual requirements

Add a concise setup section covering Tailscale Serve commands/configuration, localhost target, HTTPS origin entry, verification, iPhone installation, revocation, and private-only security boundaries. Do not make ordinary CI depend on a user's tailnet. The physical Mini/iPhone checks are opt-in and require redacted screenshots/logs only.

## Risks and follow-up decisions

- A bootstrap URL necessarily has a short residual exposure window; strict referrer policy, URL scrubbing, access-log redaction, and rapid rotation are required mitigations.
- Tailscale endpoint reachability cannot be inferred solely from local installation status. Prefer an authenticated verification request and clearly label unverified states.
- QR generation can add packaging/UI complexity; copyable one-time links are the minimum acceptance, QR is optional only if it does not widen secret exposure.
- Revoke must invalidate browser credentials without removing server sessions or push identity unless explicitly chosen later.
