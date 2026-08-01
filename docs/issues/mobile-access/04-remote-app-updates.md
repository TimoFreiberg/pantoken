# Issue: Safely expose signed Pantoken.app updates to the phone

## Context

The existing signed whole-app updater lives in `desktop/src/updater.rs`. It stages a signed release, reports availability through `/update/state`, observes the client `applyUpdate` request, checks `/health` for clients/busy state, installs the `.app`, and requests a restart. `client/src/components/Sidebar.svelte` already renders a desktop update card, while `protocol/src/wire.ts` contains `updateStatus` and `applyUpdate` contracts. The phone path must reuse this state machine, not confuse a PWA service-worker refresh with replacing the Mac app.

Remote update requests are especially sensitive because the Mini may be unattended and a restart can destroy an active polytoken turn if the safety gate is weakened. This issue hardens the already-existing flow for authenticated mobile use.

## Goal

Allow an authenticated phone client to see a staged signed update, request `Update now`, receive clear progress/reconnect behavior, and cause a safe signed Pantoken.app restart without interrupting an active turn.

## Non-goals

- Replacing minisign/signed bundle verification or inventing a second updater.
- Exposing arbitrary shell commands or unsigned app installation to the phone.
- Making PWA service-worker refresh and `.app` installation the same operation.
- Interrupting an active polytoken turn.
- Requiring a native iOS app.

## Dependencies

- Depends on `02-authenticated-sidecar.md` for authenticated `/health` and `/update/state` internal calls and fail-closed activity checks.
- Depends on `03-phone-bootstrap.md` for an authenticated, persistent phone connection.

## Repository touch points and contracts

- `desktop/src/updater.rs`: preserve signed download/install, active-turn gate, report/apply failure reset, authenticated polling, teardown, and relaunch ordering.
- `server/pantoken-server/src/hub.rs`: preserve `updateStatus`/`applyUpdate` state transitions and the applying/failed/retry semantics.
- `protocol/src/wire.ts`: keep `applyUpdate` separate from service-worker update messages.
- `client/src/components/Sidebar.svelte`, `store.svelte.ts`, and update UI styles: make copy/layout clear on narrow screens and communicate temporary Mini restart.
- Existing updater, hub, client unit, and Playwright suites: add authenticated remote scenarios.

The required apply path remains:

1. phone receives `updateStatus`;
2. phone sends `applyUpdate`;
3. hub marks the update applying;
4. desktop updater observes the request on its authenticated poll;
5. signed bundle installs;
6. Pantoken.app/hub restarts;
7. phone reconnects and receives the fresh client.

While a turn is active, the request is deferred or reports a clear non-destructive status. It must not be interpreted as permission to kill the active turn.

## Acceptance criteria

- **I4-AC.1 — Phone can apply a staged signed app update.** An authenticated phone sees the existing update status, can request `Update now`, causes the signed Pantoken.app bundle on the Mini to install/relaunch through the existing updater, and reconnects to the fresh hub/client.
- **I4-AC.2 — Updates never interrupt an active turn.** When activity is busy, a phone request is deferred and the UI explains the state; no active turn is killed, and installation begins only after the safety condition is satisfied or the request is safely withdrawn.
- **I4-AC.3 — Update failure is recoverable.** Download/install/relaunch failure produces a retryable client-visible state and clears any permanently stuck applying state; retry does not require deleting sessions or restarting by hand.
- **I4-AC.4 — App update and PWA refresh remain separate.** The implementation and tests keep staged `applyUpdate` as the v1 remote operation, keep `forceUpdate` desktop-only unless explicitly revisited, and preserve the independent service-worker refresh path.

## Verification

- `remote_update_apply_scenario`: authenticated integration scenario for availability, `updateStatus`, `applyUpdate`, updater poll, signed install seam, restart, and reconnect.
- `remote_update_defers_while_busy`: fake hub/sidecar scenario proving active-turn state blocks installation and preserves the turn.
- `remote_update_apply_failure_allows_retry`: injected download/install/relaunch failure scenario proving retryable state and cleared applying flag.
- `mobile_update_card_responsive`: Playwright scenario for narrow layout, restart warning, progress, temporary disconnect, and non-stuck completion/error states.
- `pwa_sw_update_is_separate_from_apply_update`: targeted protocol/client regression.
- `MOBILE-UPDATE-01`: physical iPhone sees a staged update, requests it, tolerates Mini restart, and reconnects to the new client.
- `MINI-UPDATE-02`: manual active-turn check confirms phone request defers without killing the turn.

## Criterion-to-verification map

| Criterion | Verification IDs |
|---|---|
| `I4-AC.1` | `remote_update_apply_scenario`, `MOBILE-UPDATE-01` |
| `I4-AC.2` | `remote_update_defers_while_busy`, `updater_does_not_apply_while_busy`, `MINI-UPDATE-02` |
| `I4-AC.3` | `remote_update_apply_failure_allows_retry` |
| `I4-AC.4` | `pwa_sw_update_is_separate_from_apply_update`, `mobile_update_card_responsive` |

## Documentation and manual requirements

Update the Mini runbook and desktop README with the distinction between PWA refresh and signed app update, expected restart duration, active-turn deferral, retry behavior, and revocation/auth requirements. Manual device validation must use a signed/test release appropriate to the environment and must not capture secrets.

## Risks and follow-up decisions

- A phone can disappear during restart; the UI needs a bounded reconnect/error path rather than an indefinite “Updating…” state.
- Updater health/auth failures must fail closed, even though that can delay unattended updates; correctness is more important than update eagerness.
- Teardown ordering matters: stop updater polling, stop remote sessions as applicable, stop the hub cleanly, then relaunch the signed bundle.
- Automatic unattended install remains governed by existing policy; this issue should not expand remote phone control into arbitrary forced installation.
