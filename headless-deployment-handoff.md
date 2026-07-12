# Headless Deployment Handoff

_Date: 2026-07-12_

## Executive status

The repository is partway through the migration from the legacy source-checkout/poller deployment to a release-based, headless Rust Pantoken service. The implementation is substantially advanced, but the deployment is **not ready to claim full acceptance**, especially for AC.5–AC.8 and live Mac Mini verification.

## Completed and committed

- Headless Rust artifact builder and validation tooling.
- Direct-root release archive containing:
  - `pantoken-server`
  - bundled client assets
  - `VERSION`
  - full `BUILD_SHA`
  - runtime wrapper
  - updater
  - tar validator
- Canonical release-host handling for `TimoFreiberg/polytoken-gui`.
- Release metadata and build-SHA contracts.
- Strict runtime environment parsing and launchd deployment foundations.
- Signed updater foundations:
  - canonical release URLs
  - semantic-tag validation
  - signature verification before extraction
  - trusted tar-validator checks
  - atomic live-link flipping
  - transaction journaling
  - lock/concurrency handling
  - launchctl/sudoers contract
  - rollback logic in the updater
- Legacy deployment paths and source-poller surfaces were substantially removed or reworked.

Latest relevant commit:

```text
33d29a8a Harden updater fixture lifecycle coverage
```

The working copy was clean after that commit.

## Verification completed

- Focused updater tests: **15 passed**
- Full Bun suite: **434 passed**
- Scripts TypeScript check: **passed**
- Focused artifact, tar-validator, smoke, deployment, and release-contract tests passed earlier in the implementation.

## Known limitation: partial updater harness

The hermetic updater harness is intentionally **partial** and does not provide full AC.5 integration coverage.

The following long-running subprocess tests were removed because they hung after the transaction had already completed successfully:

- healthy update, flip, restart, and commit
- post-flip failure and rollback

The latest journal evidence showed that the healthy transaction reached `committed`. The observed timeout was a fixture child-process lifecycle/cleanup problem after success, not evidence of an updater rollback failure.

Retained real subprocess coverage includes:

- invalid signature rejected before extraction or live-link mutation
- malicious archive rejected before extraction

Static coverage remains for rollback behavior, journaling, locking, atomic flips, restart authorization, and command ordering. It must not be described as equivalent to full integration coverage.

## Remaining engineering work

- Make fixture child-process cleanup deterministic.
- Restore healthy-update integration coverage.
- Restore rollback integration coverage.
- Add or finish stale-PID and rapid-respawn scenarios.
- Finish failed-rollback and journal-recovery scenarios.
- Finish explicit-tag recovery, retention-pruning, and concurrency integration scenarios.
- Run the real macOS `scripts/headless/launchd-platform-gate.sh` and retain evidence.
- Complete the independent implementation review.
- Finish remaining CI/publication and deployment-documentation work.

## Remaining live deployment work

Before a production cutover:

- Run the Mac Mini read-only preflight.
- Verify the installed `polytoken` version, executable path, credentials, configuration, bearer-token behavior, and live-driver interaction.
- Verify Tailscale Serve still routes `/` exactly to `http://127.0.0.1:8787`.
- Build or obtain a locally validated signed headless artifact without publishing unless separately authorized.
- Bootstrap the versioned release layout and rendered `com.pantoken.server` LaunchDaemon.
- Validate local health, HTML/static assets, WebSocket behavior, authentication, live-driver interaction, process identity, and restart recovery.
- Only after all gates pass, perform the explicitly inventoried legacy cleanup.
- Run final post-cutover verification and record the active version and full build SHA.

## Operational boundaries

- No GitHub release or tag was created.
- No commits were pushed.
- No live Mac Mini service was changed.
- No Tailscale configuration was changed.
- No destructive cleanup was performed.

The next engineer should treat this document as a status handoff, not as evidence that the production cutover or the full updater acceptance criteria are complete.
