# Local CI and release readiness

## CI-equivalent integration gate

Run `just ci-local` before integrating a change. It resolves prerequisites before
starting any gate, launches independent gates concurrently, waits for every
launched gate, and reports a sorted status plus absolute log path. A nonzero
required gate blocks integration; a host-unavailable platform gate is reported as
`SKIPPED (host unavailable)` rather than treated as passed.

| Gate | Linux | macOS arm64 | CI-equivalent commands |
|---|---|---|---|
| `web-check` | required | skipped (host unavailable) | `pnpm run check`, `pnpm run test` |
| `web-e2e` | required | skipped (host unavailable) | CPU-sized mock Playwright shards, up to four |
| `web-live` | required | skipped (host unavailable) | `pnpm run test:e2e:live` with fake daemon |
| `rust-server` | required | skipped (host unavailable) | check-only `cargo fmt`, Buck2 clippy/build/test and manifest checks |
| `desktop` | skipped (host unavailable) | required | client/hub build, Vitest, desktop fmt/clippy/nextest |
| `buck2` | skipped (host unavailable) | required | Buck2 clippy/build/test and manifest checks |

`web-live` remains one gate because its fake-daemon/session contract is isolated
by the dedicated live Playwright config. Mock shards use
`min(PANTOKEN_CI_CPUS, useful partitions, 4)` processes by default, with unique
`PANTOKEN_E2E_VITE_PORT` values; backend and data ports remain auto-assigned by
`dev.ts`. Override CPU/shards with `PANTOKEN_CI_CPUS` and
`PANTOKEN_CI_E2E_SHARDS`. Set `PANTOKEN_CI_RETAIN_LOGS=1` to retain successful
logs too. Failed logs are retained under `target/ci-local/<run-id>/` by default;
the runner cleans successful logs. The runner never installs tools: use the
explicit CI Buck2 setup script when needed.

Buck2 build/clippy commands use `scripts/ci/retry-transient.sh`; tests are never
retried. Buck2 work is sequenced within a gate for daemon/cache reuse while web
and platform gates run in parallel. Linux runs do not prove macOS desktop behavior,
and macOS runs do not prove Linux server behavior; CI supplies the unavailable
platform gate.

`integrate-into-main.sh` always invokes the full default gate. Its development
selection controls cannot bypass integration. If a gate fails, inspect the
retained absolute log paths, fix the cause, and rerun integration; no bookmark
move, push, or issue close is attempted.

## Release readiness

`just release-readiness --version X.Y.Z --build-sha <40-hex> --target <triple>`
performs the applicable local gate, then builds an unsigned Buck2 archive with
`.buckconfig.ci`, runs `just validate-archive-rs-ci` separately, validates the
returned archive with the returned trusted tar validator, and extracts/smoke-tests
that same archive. The API returns `{ archivePath, validatorPath }`, so validation
cannot accidentally inspect a different artifact.

Readiness child commands capture stdout and stderr on success and print only a
start status and a stop status with the elapsed duration. If a readiness child
fails, its captured stdout and stderr are printed after the failed stop status.
This concise output applies only to readiness child commands; outer release VCS
and metadata-mutation commands, and standalone artifact builds, keep their
existing logging.

Omit options only when using a wrapper that supplies explicit values; the release
CLI derives the next version and captures one immutable `git rev-parse HEAD` SHA
before readiness. Linux uses
`x86_64-unknown-linux-gnu`/`pantoken-headless-linux-x86_64.tar.gz`; arm64 macOS
uses `aarch64-apple-darwin`/`pantoken-headless-macos-aarch64.tar.gz`. Other hosts
or cross-host targets fail with a reason.

Readiness is credential-free: it does not sign, notarize, publish, upload, tag,
or push. Normal `just release` runs it before changing version files; `--dry-run`
only reports the plan and performs no readiness, writes, commits, tags, or pushes.
The existing CI release path remains responsible for signing and publishing.
