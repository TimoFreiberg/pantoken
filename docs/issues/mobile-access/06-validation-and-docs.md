# Issue: Validate the Mac Mini/iPhone path and reconcile documentation

## Context

The repository has Rust integration suites, client unit tests, and Playwright coverage, but no complete checked-in Mac Mini/Tailscale deployment harness. Browser automation cannot prove iOS standalone mode, Web Push while closed, LTE transitions, Tailscale reachability, or signed-app restart behavior. The final implementation therefore needs explicit hermetic seams plus opt-in Mini/iPhone checklists, and it must reconcile conflicting deployment statements in `README.md`, `desktop/README.md`, `docs/DESIGN.md`, and `docs/PLAN-mobile.md`.

This issue is the validation and documentation integration gate for `01-remote-contract.md` through `05-mini-lifecycle.md`. It must not pretend that browser tests replace physical-device or tailnet checks.

## Goal

Add deterministic automated coverage for the fixed-port/authenticated contract, define fake-sidecar and authenticated-router test seams, run opt-in tailnet and physical-iPhone validation, and leave the repository documentation and Mini runbook consistent with the supported private topology.

## Non-goals

- Making ordinary CI depend on Tailscale, a user's Mac Mini, an iPhone, or public network infrastructure.
- Reimplementing product behavior in tests or docs.
- Adding a VPS, direct port forwarding, Funnel, or a second mobile backend.
- Treating browser-only E2E as proof of iOS push or lifecycle behavior.
- Modifying product source during this issue-artifact creation session; these are requirements for a later implementation issue.

## Dependencies

- Depends on `01-remote-contract.md`, `02-authenticated-sidecar.md`, `03-phone-bootstrap.md`, `04-remote-app-updates.md`, and `05-mini-lifecycle.md`.

## Repository touch points and contracts

- Rust desktop/server test modules under `desktop/` and `server/pantoken-server/`: pure config/env/token/port tests, authenticated Axum router fixture, and fake sidecar HTTP seam.
- Client/Playwright suites: phone-visible bootstrap/update/layout scenarios, supplemental only for platform behavior.
- `README.md`: explain that a Mac Mini can host the supervised single-user hub for PWA access without claiming generic multi-tenant deployment.
- `desktop/README.md`: stable remote mode, loopback binding, bearer auth, Tailscale Serve, lifecycle, updates, and troubleshooting.
- `docs/DESIGN.md`: supported topology/security boundary and corrected protocol-version claims.
- `docs/PLAN-mobile.md`: reconcile plan with the implemented contract and remove/qualify stale deployment assumptions.
- New focused Mini deployment runbook: installation, Serve, enablement, phone installation, updates, revocation, troubleshooting, and security boundaries.

### Required automated seams

1. pure desktop configuration/env tests that do not mutate process-global environment concurrently;
2. fake sidecar/HTTP server that records authenticated `/health` and `/update/state` calls and injects timeout, 401, malformed, and unavailable responses;
3. authenticated Axum router integration fixture covering HTTP/static/WS/push/update/debug routes;
4. opt-in Tailscale Serve test that uses a user-provided origin and distinguishes endpoint-unverified, wrong-target, hub-unavailable, and authentication-failure;
5. physical iPhone checklist for PWA installation, token persistence, push, deep links, badges, background/network transitions, hub restart, signed app update, active-turn safety, dark mode, and safe areas.

## Acceptance criteria

- **I6-AC.1 — Real-device PWA and push behavior work.** On a physical iPhone, the PWA installs from the HTTPS tailnet origin, bootstraps/scrubs/persists its token, receives Web Push while closed, deep-links to approvals, sets/clears badges, reconnects after backgrounding and Wi-Fi/LTE changes, survives hub restart and app update, and renders dark mode/safe areas correctly.
- **I6-AC.2 — Existing desktop behavior remains intact.** Local-only startup, retained random-port development behavior, local omission of remote auth, tray lifetime, supervisor health gating, signed updater behavior, and PWA/app-update separation pass targeted regressions plus `just quality`, `just check-rs`, and existing desktop/mobile E2E suites.
- **I6-AC.3 — Validation infrastructure is hermetic and documentation is consistent.** Automated tests cover fixed-port/authenticated startup without Tailscale; the fake sidecar and authenticated router seams exist; opt-in Mini/tailnet/device checklists are documented; README, desktop README, DESIGN, PLAN-mobile, and the Mini runbook agree on private Tailscale Serve/loopback deployment and contain no contradictory direct-exposure, second-backend, stale `deploy/`, or protocol-version claims.

## Verification

- `issue_artifact_manifest_check` and `issue_artifact_scope_check` validate this issue set during artifact generation; the later implementation must retain equivalent deterministic checks for the implementation's test/docs deliverables.
- `authenticated_fixed_port_hermetic_suite`: Rust tests with no Tailscale or external network.
- `fake_sidecar_supervisor_updater_suite`: captures bearer headers and exercises fail-closed health/activity behavior.
- `authenticated_axum_router_fixture`: HTTP/WS/push/update/debug route matrix and bootstrap restrictions.
- `tailscale_endpoint_opt_in_smoke`: user-provided-origin check with explicit endpoint state classification; never ordinary CI.
- `remote_access_architecture_docs`: topology and security docs review plus stale contradictory-deployment search.
- `just quality`, `just check-rs`, existing desktop/mobile E2E, targeted updater tests, and client tests.
- `MOBILE-AUTH-01`: bootstrap, URL scrubbing, persistence, redaction, and header behavior on a physical iPhone.
- `MOBILE-PWA-01`: install from HTTPS tailnet origin.
- `MOBILE-PWA-02`: closed-app Web Push receipt.
- `MOBILE-PWA-03`: notification approval deep link.
- `MOBILE-PWA-04`: badge set/clear.
- `MOBILE-PWA-05`: relaunch/token persistence.
- `MOBILE-PWA-06`: background/foreground and Wi-Fi/LTE reconnect.
- `MOBILE-PWA-07`: hub restart and signed app update reconnect.
- `MOBILE-PWA-08`: active-turn safety plus dark mode/safe-area review.
- `TAILNET-PRIVATE-01`: Serve/private-tailnet reachability without direct public exposure.

## Criterion-to-verification map

| Criterion | Verification IDs |
|---|---|
| `I6-AC.1` | `MOBILE-AUTH-01`, `MOBILE-PWA-01`, `MOBILE-PWA-02`, `MOBILE-PWA-03`, `MOBILE-PWA-04`, `MOBILE-PWA-05`, `MOBILE-PWA-06`, `MOBILE-PWA-07`, `MOBILE-PWA-08`, `TAILNET-PRIVATE-01` |
| `I6-AC.2` | `just_quality`, `just_check_rs`, `existing_desktop_mobile_e2e`, `tray_close_keeps_supervisor_alive`, `updater_does_not_apply_while_busy`, `pwa_sw_update_is_separate_from_apply_update` |
| `I6-AC.3` | `issue_artifact_manifest_check`, `issue_artifact_scope_check`, `authenticated_fixed_port_hermetic_suite`, `fake_sidecar_supervisor_updater_suite`, `authenticated_axum_router_fixture`, `tailscale_endpoint_opt_in_smoke`, `remote_access_architecture_docs` |

## Documentation and manual requirements

The Mini runbook must include install, Tailscale Serve, explicit origin, enabling access, iPhone installation/bootstrap, push verification, updates/reconnect, active-turn behavior, revoke/regenerate, troubleshooting states, and security boundaries. Mark physical-device and tailnet checks as manual/opt-in, record device/iOS/browser/app versions, and redact tokens from evidence.

## Risks and follow-up decisions

- iOS Web Push and standalone PWA behavior can regress independently of browser E2E; the physical checklist is acceptance, not optional polish.
- Tailscale CLI/configuration varies by version and account policy; test only against a user-provided origin and keep it out of ordinary CI.
- Documentation cleanup may reveal unresolved protocol or deployment history; preserve historical notes only when clearly qualified and ensure the supported v1 path is unambiguous.
- The test seams must not weaken production auth or turn fail-closed behavior into a test-only special case.
