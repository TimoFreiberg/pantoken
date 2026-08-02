# Issue: Make the Mac Mini hub an opt-in always-on service

## Context

The Tauri shell already keeps a supervised sidecar alive in the tray, and `desktop/src/state.rs` owns teardown. The remaining Mac Mini experience must survive reboot, logout/login, window close, sleep/wake, hub crashes, and Tailscale reconnect without turning the desktop app into an uncontrolled daemon. The approved v1 startup decision is opt-in macOS Service Management through `SMAppService.mainApp`.

This issue owns lifecycle and diagnostics, not the remote auth contract or phone bootstrap UX.

## Goal

Provide predictable opt-in launch-at-login behavior, preserve tray/hub semantics, recover from ordinary hub/network failures, and expose useful redacted diagnostics for a Mini operator.

## Non-goals

- Running an independently managed server outside Pantoken.app.
- Silent launch-at-login opt-in or a public network service.
- Replacing the supervisor with launchd scripts as the implementation path.
- Showing bearer tokens or other secrets in diagnostics.
- Changing signed updater verification.

## Dependencies

- Depends on `01-remote-contract.md` for `SMAppService.mainApp` registration and remote topology decisions.
- Depends on `02-authenticated-sidecar.md` for stable-port startup, authenticated health, and fail-closed liveness.
- `04-remote-app-updates.md` depends on the teardown/relaunch ordering defined here.
- `06-validation-and-docs.md` owns the final Mini reboot/sleep/network checklist and runbook consolidation.

## Repository touch points and contracts

- `desktop/src/main.rs`: startup registration/status integration and startup without a manually opened window.
- `desktop/src/state.rs`: supervisor/updater stop ordering, explicit Quit teardown, and last-health/endpoint status storage.
- `desktop/src/supervisor.rs`: crash/hang recovery and redacted health diagnostics.
- `desktop/src/updater.rs`: stop polling before shutdown and hand off cleanly to signed relaunch.
- Tauri/macOS bundle metadata/helper configuration: register the main app with the selected identifier and verify packaged behavior.
- Tray/window shell code and `desktop/README.md`: preserve close-vs-Quit semantics and explain lifecycle controls.

Required semantics:

- opt-in launch-at-login starts the app/supervisor after reboot or login without requiring a visible window;
- closing the main window leaves the supervisor/hub and remote availability alive;
- explicit Quit stops updater polling, remote sessions as applicable, and the hub, making the remote endpoint unavailable;
- hub crash/hang recovery uses the existing supervisor and never treats failed authenticated health as idle;
- diagnostics report last health, restart/recovery, configured endpoint verification, and timestamps without tokens.

## Acceptance criteria

- **I5-AC.1 — Always-on Mini lifecycle works.** After opt-in `SMAppService.mainApp` registration, the Mini serves the phone after reboot/login without manually opening the Pantoken window; window close preserves service availability; explicit Quit stops the hub and remote availability; registration enable/disable/update/uninstall/failure states are user-visible.
- **I5-AC.2 — Recovery and diagnostics are safe.** Supervisor recovery handles hub crash/hang, app restart, logout/login, sleep/wake, and normal Tailscale reconnect without data loss; diagnostics distinguish the last health and endpoint state and never show bearer tokens; updater and hub teardown ordering is safe.

## Verification

- `mini_startup_lifecycle_manual`: packaged signed-app checklist for first opt-in, reboot, login, no-window startup, close-window, explicit Quit, disable, update, uninstall, and registration failure.
- `supervisor_remote_mode_restarts_and_recovers`: fake sidecar/supervisor tests for crash, hang, authenticated health failure, restart, and recovery.
- `tray_close_keeps_supervisor_alive`: desktop regression proving window close does not stop the hub.
- `lifecycle_diagnostics_redacted`: assertions that status payloads/logs contain no token and report useful last-health/endpoint state.
- `updater_teardown_order`: deterministic stop-order test and signed-package manual relaunch check.
- `MINI-LIFECYCLE-01`: reboot/login reachability from the iPhone.
- `MINI-LIFECYCLE-02`: sleep/wake and Tailscale disconnect/reconnect behavior.
- `MINI-LIFECYCLE-03`: hub crash/hang recovery and data/session preservation.

## Criterion-to-verification map

| Criterion | Verification IDs |
|---|---|
| `I5-AC.1` | `mini_startup_lifecycle_manual`, `tray_close_keeps_supervisor_alive`, `MINI-LIFECYCLE-01` |
| `I5-AC.2` | `supervisor_remote_mode_restarts_and_recovers`, `lifecycle_diagnostics_redacted`, `updater_teardown_order`, `MINI-LIFECYCLE-02`, `MINI-LIFECYCLE-03` |

## Documentation and manual requirements

Document opt-in launch-at-login, tray close versus Quit, restart/recovery expectations, diagnostics, and security boundaries in the desktop README and Mini runbook. Manual checks must use a dedicated Mini/test account and redacted evidence. User-managed Login Items and launch-agent/helper workarounds are explicitly outside v1 and are not configured or supported by Pantoken. The hub remains loopback-only; this issue does not document public binding or standalone-server operation.

### `mini_startup_lifecycle_manual`

Run only against a signed packaged `.app`, using a dedicated test account. Record timestamps, visible state, reachability, and status/error text; redact tokens, Authorization headers, credential-bearing URLs, and raw diagnostic payloads.

1. Run `scripts/desktop/validate-macos-app.sh --app /path/to/Pantoken.app`; capture the reported artifact and packaged identifier/minimum-version checks.
2. In Settings, enable launch-at-login. Confirm the actual `SMAppService.mainApp` state is registered/enabled; separately record approval-required, failure, or unavailable states. Disable it and confirm the queried state changes. Do not infer status from preferences or `smctl`.
3. **MINI-LIFECYCLE-01:** reboot/login with registration enabled. Confirm the tray, supervised hub, and phone reachability are available during headless startup while no main window is visible; use Tray Open to reveal/focus it.
4. Close the window (close-to-tray) and confirm the window hides while phone reachability and supervisor health remain available. Use Tray Open again.
5. **MINI-LIFECYCLE-02:** exercise sleep/wake and Tailscale disconnect/reconnect. Record endpoint-unverified/unreachable versus recovered authenticated health without treating a failed probe as updater-idle.
6. **MINI-LIFECYCLE-03:** induce a hub crash and hang. Confirm bounded restart/recovery, session preservation, and a visible crash-loop/boot-timeout stop state when recovery is exhausted.
7. Use Cmd+Q and Tray Quit separately. Confirm both perform teardown and make the endpoint unavailable; ordinary window close must not.
8. **MINI-UPDATE-02:** apply a signed update. Confirm updater polling stops before teardown/relaunch, reconnect succeeds, and an install failure clears apply state while retaining a retryable staged version. Retry once, then inspect redacted diagnostics.
9. Disable registration, uninstall the app, and record the resulting status/error and endpoint behavior. No helper executable, launch agent, public binding, or standalone server is part of this v1 checklist.

## Risks and follow-up decisions

- macOS registration behavior can differ between unsigned development builds and signed packaged apps; packaging checks are mandatory.
- Sleep/network transitions may look like hub failure; status must distinguish endpoint-unverified/Tailscale loss from authenticated hub failure where possible.
- Quit/restart races can orphan the sidecar unless updater, remote sessions, supervisor, and hub shutdown order is explicit and tested.
