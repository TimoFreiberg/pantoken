# Mac Mini mobile-access issue artifact manifest

This manifest is the index for the six directly pasteable GitHub issue bodies in this directory. The files describe future implementation work; they do not claim that the product behavior has landed.

## Artifact set

| Order | File | GitHub issue title | Depends on | Scope |
|---:|---|---|---|---|
| 1 | `01-remote-contract.md` | Freeze the Mac Mini remote-access contract and configuration model | none | Architecture, configuration, security, Keychain, bootstrap, and startup decisions |
| 2 | `02-authenticated-sidecar.md` | Start a stable-port, authenticated Pantoken sidecar | `01-remote-contract.md` | Stable port, sidecar environment, route/auth matrix, supervisor/updater internal auth |
| 3 | `03-phone-bootstrap.md` | Add explicit phone bootstrap and remote-access UX | `01-remote-contract.md`, `02-authenticated-sidecar.md` | Explicit origin, manual Tailscale Serve, bootstrap/revoke UX, endpoint status |
| 4 | `04-remote-app-updates.md` | Safely expose signed Pantoken.app updates to the phone | `02-authenticated-sidecar.md`, `03-phone-bootstrap.md` | Authenticated staged app updates and active-turn safety |
| 5 | `05-mini-lifecycle.md` | Make the Mac Mini hub an opt-in always-on service | `01-remote-contract.md`, `02-authenticated-sidecar.md` | Launch-at-login, tray/Quit semantics, recovery, diagnostics |
| 6 | `06-validation-and-docs.md` | Validate the Mac Mini/iPhone path and reconcile documentation | all previous files | Hermetic/opt-in/device validation, test seams, documentation/runbook cleanup |

## Criterion ownership

Every issue-local criterion is allocated exactly once below. The future cross-issue requirements are owned as follows:

| Future requirement | Owning issue | Artifact |
|---|---|---|
| AC.3 supported topology | Issue 1 (`01-remote-contract.md`) | `01-remote-contract.md` |
| AC.4 stable configured port | Issue 2 (`02-authenticated-sidecar.md`) | `02-authenticated-sidecar.md` |
| AC.5 loopback-only bind | Issue 2 (`02-authenticated-sidecar.md`) | `02-authenticated-sidecar.md` |
| AC.6 auth and shell internal contract | Issue 2 (`02-authenticated-sidecar.md`) | `02-authenticated-sidecar.md` |
| AC.7 token lifecycle/bootstrap safety | Issue 2 (`02-authenticated-sidecar.md`) | `02-authenticated-sidecar.md` |
| AC.8 explicit/recoverable phone bootstrap | Issue 3 (`03-phone-bootstrap.md`) | `03-phone-bootstrap.md` |
| AC.9 private Tailscale exposure | Issue 3 (`03-phone-bootstrap.md`) | `03-phone-bootstrap.md` |
| AC.10 staged signed app update | Issue 4 (`04-remote-app-updates.md`) | `04-remote-app-updates.md` |
| AC.11 active-turn update safety | Issue 4 (`04-remote-app-updates.md`) | `04-remote-app-updates.md` |
| AC.12 recoverable update failure | Issue 4 (`04-remote-app-updates.md`) | `04-remote-app-updates.md` |
| AC.13 always-on Mini lifecycle | Issue 5 (`05-mini-lifecycle.md`) | `05-mini-lifecycle.md` |
| AC.14 real-device PWA/push behavior | Issue 6 (`06-validation-and-docs.md`) | `06-validation-and-docs.md` |
| AC.15 existing desktop behavior | Issue 6 (`06-validation-and-docs.md`) | `06-validation-and-docs.md` |

The supplementary issue-local criteria for endpoint UX, update separation, lifecycle diagnostics, and validation/docs consistency are included in the complete inventory below, each exactly once.

## Complete criterion inventory

| Criterion ID | File | Short description |
|---|---|---|
| `I1-AC.1` | `01-remote-contract.md` | Supported topology explicit |
| `I1-AC.2` | `01-remote-contract.md` | Remote configuration deterministic and safe |
| `I1-AC.3` | `01-remote-contract.md` | Bootstrap and lifecycle decisions testable |
| `I1-AC.4` | `01-remote-contract.md` | Documentation discrepancies have owners |
| `I2-AC.1` | `02-authenticated-sidecar.md` | Stable configured port |
| `I2-AC.2` | `02-authenticated-sidecar.md` | Loopback-only sidecar |
| `I2-AC.3` | `02-authenticated-sidecar.md` | Remote and internal auth complete |
| `I2-AC.4` | `02-authenticated-sidecar.md` | Token/bootstrap safety |
| `I2-AC.5` | `02-authenticated-sidecar.md` | Local behavior compatible |
| `I3-AC.1` | `03-phone-bootstrap.md` | Explicit/recoverable bootstrap |
| `I3-AC.2` | `03-phone-bootstrap.md` | Private Tailscale exposure |
| `I3-AC.3` | `03-phone-bootstrap.md` | Actionable endpoint/mobile UX |
| `I4-AC.1` | `04-remote-app-updates.md` | Phone applies signed update |
| `I4-AC.2` | `04-remote-app-updates.md` | Active-turn safety |
| `I4-AC.3` | `04-remote-app-updates.md` | Recoverable update failure |
| `I4-AC.4` | `04-remote-app-updates.md` | App/PWA update separation |
| `I5-AC.1` | `05-mini-lifecycle.md` | Always-on lifecycle |
| `I5-AC.2` | `05-mini-lifecycle.md` | Recovery and safe diagnostics |
| `I6-AC.1` | `06-validation-and-docs.md` | Physical PWA/push behavior |
| `I6-AC.2` | `06-validation-and-docs.md` | Existing desktop behavior |
| `I6-AC.3` | `06-validation-and-docs.md` | Hermetic validation/docs consistency |

## Verification inventory

Verification IDs are unique across the issue set. A verification may be listed as shared only when it is an artifact-level or repository-wide check.

| Verification ID | Owning issue | Covers |
|---|---|---|
| `remote_access_architecture_docs` | `I1`, `I6` (shared) | Supported topology, loopback/security boundary, stale contradictory docs |
| `remote_contract_config_matrix` | `I1` | Persisted field/default/owner/failure matrix |
| `bootstrap_contract_review` | `I1` | Bootstrap and query-token contract |
| `startup_registration_packaging_review` | `I1` | SMAppService and signed packaging behavior |
| `stale_deployment_and_protocol_search` | `I1` | Stale deploy/protocol claims inventory |
| `desktop_config_remote_port_persists` | `I2` | Stable port config and collision/invalid paths |
| `desktop_sidecar_env_remote_mode` | `I2` | Remote/local env construction |
| `remote_mode_forces_loopback_bind` | `I2` | Loopback bind |
| `remote_mode_auth_required` | `I2` | HTTP route matrix auth |
| `unauthenticated_ws_rejected` | `I2` | WS upgrade/hello rejection |
| `authenticated_ws_and_push_allowed` | `I2` | Authenticated WS/push success |
| `supervisor_health_auth_contract` | `I2` | Authenticated health and fail-closed liveness |
| `updater_report_auth_contract` | `I2` | Authenticated updater activity/report |
| `token_persistence_and_rotation` | `I2` | Keychain lifecycle and redaction |
| `bootstrap_expiry_replay` | `I2` | Expiry/replay and ordinary-route restrictions |
| `local_mode_keeps_random_port` | `I2` | Local compatibility |
| `local_mode_omits_remote_token` | `I2` | Local compatibility |
| `tray_close_keeps_supervisor_alive` | `I2`, `I5` (shared) | Existing tray lifetime |
| `updater_does_not_apply_while_busy` | `I2`, `I4` (shared) | Active-turn update safety |
| `pwa_sw_update_is_separate_from_apply_update` | `I2`, `I4` (shared) | Update separation |
| `phone_bootstrap_flow` | `I3` | Phone setup and URL/header behavior |
| `token_query_route_restrictions` | `I3` | Bootstrap-only query auth |
| `endpoint_status_matrix` | `I3` | Endpoint state distinctions |
| `tailscale_setup_docs_private_only` | `I3` | Private Serve documentation |
| `mobile_update_card_responsive` | `I4` | Mobile update UX |
| `remote_update_apply_scenario` | `I4` | Authenticated signed update flow |
| `remote_update_defers_while_busy` | `I4` | Active-turn deferral |
| `remote_update_apply_failure_allows_retry` | `I4` | Retryable failure |
| `mini_update_manual_active_turn` | `I4` | Physical active-turn check |
| `mini_startup_lifecycle_manual` | `I5` | Launch-at-login and tray lifecycle |
| `supervisor_remote_mode_restarts_and_recovers` | `I5` | Crash/hang/network recovery |
| `lifecycle_diagnostics_redacted` | `I5` | Safe diagnostics |
| `updater_teardown_order` | `I5` | Shutdown/relaunch ordering |
| `authenticated_fixed_port_hermetic_suite` | `I6` | No-Tailscale contract tests |
| `fake_sidecar_supervisor_updater_suite` | `I6` | Fake sidecar seam |
| `authenticated_axum_router_fixture` | `I6` | Authenticated router fixture |
| `tailscale_endpoint_opt_in_smoke` | `I6` | Opt-in endpoint semantics |
| `just_quality` | `I6` (shared) | Repository quality checks |
| `just_check_rs` | `I6` (shared) | Rust checks |
| `existing_desktop_mobile_e2e` | `I6` (shared) | Regression suites |
| `MOBILE-AUTH-01` | `I6` | Physical auth/bootstrap |
| `MOBILE-UPDATE-01` | `I4` | Physical update/reconnect |
| `MOBILE-PWA-01` | `I6` | HTTPS install |
| `MOBILE-PWA-02` | `I6` | Closed-app push |
| `MOBILE-PWA-03` | `I6` | Approval deep link |
| `MOBILE-PWA-04` | `I6` | Badge behavior |
| `MOBILE-PWA-05` | `I6` | Relaunch/token persistence |
| `MOBILE-PWA-06` | `I6` | Background/network reconnect |
| `MOBILE-PWA-07` | `I6` | Restart/update reconnect |
| `MOBILE-PWA-08` | `I6` | Safety, dark mode, safe areas |
| `TAILNET-PRIVATE-01` | `I6` | Private tailnet smoke test |
| `MINI-SETUP-01` | `I3` | Tailscale membership |
| `MINI-SETUP-02` | `I3` | Serve setup |
| `MINI-SETUP-03` | `I3` | Origin verification |
| `MINI-SETUP-04` | `I3` | iPhone bootstrap |
| `MINI-SETUP-05` | `I3` | Revoke/regenerate |
| `MINI-SETUP-06` | `I3` | Error-state checks |
| `MINI-UPDATE-02` | `I4` | Active-turn update check |
| `MINI-LIFECYCLE-01` | `I5` | Reboot/login reachability |
| `MINI-LIFECYCLE-02` | `I5` | Sleep/network recovery |
| `MINI-LIFECYCLE-03` | `I5` | Hub crash/data preservation |

## Artifact-level acceptance

- Exactly six issue bodies are present, with the stable filenames in the table above.
- Each issue body is standalone Markdown with title, context, goal, non-goals, dependencies, touch points/contracts, acceptance criteria, verification, documentation/manual requirements, and risks/follow-ups.
- Criterion IDs are unique, issue-scoped, and each maps to named verification in its issue body.
- Dependency edges are acyclic and use the stable filenames above.
- No product source or existing documentation is changed by the execute session. Only this directory is created/modified.

## Review note

The requested independent `plan-reviewer` review was attempted before artifact creation but could not run because the configured provider returned an authentication failure. A second general-purpose review attempt failed for the same provider-auth reason. No reviewer claimed a finding, and the approved plan's decomposition and ownership table were retained; the artifact-level checks above are the deterministic review substitute for this documentation-only execution.
