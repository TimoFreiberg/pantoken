# Buck2 policy

Buck2 is the primary local build and test system for the Rust server crates and the **release-authoritative builder for the headless artifacts** (the unsigned archive + tar validator are built via `build.ts --builder buck2` with release-mode flags). Cargo remains the local fallback builder (`--builder cargo`) and still owns the Tauri desktop packaging path. pnpm remains authoritative for JavaScript.

## Pins and ownership

The supported Buck2 revision is `2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc`, verified by `buck2/bootstrap.sh` and `scripts/buck2/check-version.sh`. Reindeer must be installed from commit `efe17c7bb0b547ed7d48111ebcbeea5fa42a904`; the check script verifies that Reindeer is available, while the installer command or reviewed installation record is responsible for confirming this revision. Rust is pinned to 1.97.1 for `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`, matching `rust-toolchain.toml`.

Update these pins together: edit the pin in `buck2/bootstrap.sh` and `scripts/buck2/check-version.sh`, reinstall the pinned Buck2 binary, run `just verify-rs`, then run `just build-rs`, `just test-rs`, and the Cargo checks. Keep the pin and generated dependency changes in one reversible diff.

## Supported platforms

macOS arm64 (`aarch64-apple-darwin`) is the primary development target. Linux amd64 (`x86_64-unknown-linux-gnu`) is supported in CI via the `rust-server` job. Linux arm64 (`aarch64-unknown-linux-gnu`) is accepted by the version check but not yet tested in CI. Windows is unsupported.

## Local setup (one-time)

Buck2's `system_rust_toolchain` invokes `rustc` by bare name, and ring's
buildscript fixup narrows the sandbox PATH to system directories
(`/usr/bin:/bin:/usr/sbin:/sbin` on Linux, plus
`/Library/Developer/CommandLineTools/usr/bin` on macOS). This excludes
rustup's `~/.cargo/bin`, so `rustc` is invisible inside the sandbox. The
prelude's `buildscript_run.py` calls `ensure_rustc_available()` before any
buildscript, causing ring (and any `cc`-based crate) to fail with
`rustc: command not found`.

Fix: run `just setup-sandbox-rustc` once. It symlinks `rustc` into a
sandbox-visible directory (`/Library/Developer/CommandLineTools/usr/bin` on
macOS, `/usr/bin` on Linux). CI does this automatically via
`scripts/ci/install-buck2-ci.sh`.

The preflight check (`scripts/buck2/check-version.sh`) warns when this is
missing. Targets that don't depend on ring (e.g. `pantoken-protocol`,
`pantoken-daemon-types`) build fine without it.

## Boundary and non-goals

The initial boundary is the deterministic `server` Rust libraries, binaries, tests, and unsigned headless archive inputs. Buck2 also builds the server binary consumed by the dev server (`scripts/dev.ts`) and the desktop hub (`scripts/desktop/build-hub.ts`). Buck2 consumes declared frontend outputs only; it does not run Vite, JavaScript tests, or Playwright. It does not package Tauri, sign artifacts, access credentials, deploy, or publish.

All 5 server crates build successfully under Buck2, including the `pantoken-server` binary (the OpenSSL gap was resolved in Issue #119 via the ece RustCrypto fork and reqwest rustls-tls switch). See the “No OpenSSL policy” decision in `docs/DECISIONS.md`. Cargo and pnpm direct workflows must remain usable.

## Target conventions

Use package-local, descriptive `snake_case` labels. Public library, binary, and archive interfaces use `visibility = ["PUBLIC"]`; build helpers and generated intermediates use `visibility = []`. `rust_library`, `rust_binary`, and `rust_test` declare every `srcs`, `deps`, and runtime `data`/`resources`. `sh_test` declares its scripts and executable/data labels. Keep targets near their sources.

Buck2 `rust_test` has no `data` attribute; test data files are declared via `resources` and referenced in `run_env` with `$(location)`. The `expected-targets.toml` manifest (`buck2/expected-targets.toml`) validates that the Buck2 graph exactly matches expectations; `just targets-check-rs` fails on omissions or unexpected targets.

## Reindeer and dependency updates

`Cargo.toml` and `Cargo.lock` are the Rust dependency source of truth. `third-party/Cargo.toml` is a dummy workspace crate representing the dependency closure of the five `server` crates. After a Rust dependency change, run the normal Cargo update/check flow, then `just deps-regenerate-rs` (which runs `reindeer buckify`). Review the generated `third-party/BUCK` and `third-party/fixups/` diff before committing. `just deps-check-rs` verifies that regeneration produces no diff.

Fixups live in `third-party/fixups/<crate>/fixups.toml`, Reindeer's default location. `reindeer.toml` sets `cargo_env = true` to provide `CARGO_PKG_*` environment variables. The generated BUCK file and fixups are checked in; vendored sources (`third-party/vendor/`) are gitignored and regenerated on demand by `reindeer vendor` for offline development only. Normal Buck2 builds download crate sources via `http_archive` rules (from crates.io, sha256-verified) or hit the remote REAPI cache. `Cargo.lock` and `pnpm-lock.yaml` remain authoritative and are not replaced by Reindeer output. Review generated BUCK files separately from application lockfile changes, but use one documented update workflow and a reversible diff.

## Hermeticity and path stability

Buck2’s sandboxed `buildscript_run` isolates build scripts from the host environment. No target may inherit ambient environment, credentials, or host paths. Tests that need environment variables set them explicitly via `run_env`. `CARGO_MANIFEST_DIR` is set through the target `env` attribute, not inherited from the host.

The `run-reindeer.sh` wrapper sets the absolute `manifest_path` dynamically to avoid hardcoding checkout-specific paths. Generated metadata, including `third-party/BUCK`, must be free of machine- or workspace-local absolute paths; `CARGO_MANIFEST_DIR` values use relative paths such as `adler2-2.0.1.crate` (for http_archive crates) or `ece-2.3.1-rustcrypto` (for the in-tree fork). `just test-inventory-check-rs` validates the test inventory against expected targets and rejects undeclared entries. `buck2/test-inventory.toml` documents environment allowlist/clears, socket usage, temp root, and network policy for every test target.

## Remote cache (always-on)

Buck2 has no local disk cache (`--disk_cache` equivalent); the daemon is
in-memory only, so `buck2 kill` causes a full rebuild. A shared `bazel-remote`
instance on the always-on Mac mini provides cross-workspace and post-restart
action-result reuse via the REAPI content-addressable store (CAS) + action
cache (AC).

### Configuration

Remote cache is **always-on**. The repo is public, so the Tailscale cache
address lives in a gitignored `.buckconfig.local` (auto-read by buck2, no
`--config-file` flag needed). Copy `.buckconfig.local.example` to
`.buckconfig.local` and fill in the real Tailscale address. All `just *-rs`
recipes use the remote cache automatically.

The local config sets:
- `[buck2_re_client]` — engine/CAS/AC addresses, `tls = false` (WireGuard
  provides transport security via Tailscale), `instance_name = buck2`.
- `[build] execution_platforms = toolchains//platforms:remote_cache` — a custom
  execution platform that sets `CommandExecutorConfig(local_enabled=True,
  remote_enabled=False, remote_cache_enabled=True, allow_cache_uploads=True)`.

**Daemon startup snapshots the RE config.** Buck2 parses
`[buck2_re_client]` when the daemon starts and freezes it for the
daemon's lifetime — the per-command config re-parse covers execution
platforms but not the RE client addresses. If `.buckconfig.local`
appears or changes while a daemon is already running, the next build
fails every action with `Internal error (stage: remote_action_cache):
Remote Execution Error ... Error: (No engine address)`. Run `buck2 kill`
after writing `.buckconfig.local` to start the daemon with the current
config. CI's `release-prepare` job orders the Tailscale/cache steps
before any buck2 invocation and restarts the daemon before the headless
release build for this reason (see "Release builds in CI").

### Cache uploads (BUCK2_TEST_FORCE_CACHE_UPLOAD)

Due to a buck2 bug where `allow_cache_uploads=True` doesn't trigger the
`CacheUploader` with `RemoteEnabledExecutor::Local`, cache uploads require
`BUCK2_TEST_FORCE_CACHE_UPLOAD=true` in the environment. This is set in
`.envrc` (local) and in CI job env. Without it, cache reads work (AC GETs)
but writes don't (no AC/CAS PUTs).

### Fallback behavior

When the remote cache is unreachable, Buck2 falls back to local execution
automatically (local execution is enabled). No explicit fallback config is
needed. Use `buck2 build --local-only` to force local execution without cache
queries.

### Observability

Cache hit/miss rates appear in the build console summary line
(`Commands: N (cached: X, remote: Y, local: Z)`). Use
`buck2 log what-ran --recent 0` to see per-command execution kind and
`buck2 log what-uploaded --recent 0` for upload stats.

### Security

- Transport: WireGuard via Tailscale (no TLS needed for the cache itself).
- No secrets in cache: the Buck2 POC boundary excludes signing, notarization,
  and publishing. The cache contains compiled Rust artifacts and unsigned
  archive inputs only.
- Instance namespacing: `instance_name = buck2` with
  `--enable_ac_key_instance_mangling` isolates Buck2's cache entries in the
  shared REAPI store.
- Untrusted PRs: fork PRs do not generate `.buckconfig.local`, so
  Buck2 uses local-only execution automatically. This prevents cache
  poisoning — untrusted code never writes to the shared cache. Same-repo
  PRs and pushes connect to Tailscale and use the remote cache.

## Release mode

Release headless artifacts are built via `build.ts --builder buck2` (CI's
`release-prepare` / `release-prepare-linux` jobs; see "Release builds in CI"
below). The build writes `.buckconfig.ci` (gitignored) with a `[pantoken]`
section and passes it via `--config-file`:

```ini
[pantoken]
version = <tag version>
build_sha = <40-hex build SHA>
release_build = 1
```

Config values participate in the action cache key (same mechanism as the root
`BUCK`'s `version_file`/`build_sha_file`), so dev and release builds get
separate cache entries and coexist in the remote cache.

`release_build = 1` switches on release codegen flags **toolchain-level** in
`toolchains/BUCK`: `-C opt-level=3 -C codegen-units=1 -C strip=symbols`. The
pinned prelude's `_compute_common_args` applies `toolchain_info.rustc_flags`
to every rustc invocation, so first-party crates **and** reindeer-generated
third-party crates (tokio/axum/reqwest/ring) are optimized in the release
binary — matching Cargo's `[profile.release]` behaviorally.

Divergences from Cargo's release profile (both accepted and documented here):

- **No thin LTO.** Cargo's `lto = "thin"` applies profile-wide; propagating it
  into the reindeer-generated `third-party/BUCK` is invasive. Measured locally
  (macOS arm64, current source, 2026-07-31): Buck2 release binary ≈ 10.08 MiB
  vs Cargo release ≈ 10.34 MiB (Buck2 ≈ 2.5% smaller; both stripped). Parity to
  Cargo is behavioral, not byte-identical.
- **`build.rs` SHA validation doesn't run under Buck2.** Cargo's `build.rs`
  enforces a 40-hex `PANTOKEN_BUILD_SHA` for release; under Buck2 the value
  comes from the config directly. The smoke test's SHA assertion (archive
  `BUILD_SHA` == running binary's reported `PANTOKEN_BUILD_SHA`) is the
  backstop — it stays mandatory in CI.
- **Relative `CARGO_MANIFEST_DIR` at runtime (latent).** The BUCK env sets
  `CARGO_MANIFEST_DIR` relative (`server/pantoken-server`), while Cargo
  sets an absolute path; `config.rs` resolves client-dist relative to CWD at
  runtime. The headless archive ships no client-dist and the smoke test runs
  from the repo root, so this is latent.

`--builder cargo` remains available (`build.ts --builder cargo`) as the local
rollback selector; it builds with Cargo's release profile exactly as before.

## CI integration

Buck2 runs in CI as the **primary build+test gate** for the Rust server. The `rust-server` job in `.github/workflows/ci.yml` runs on `ubuntu-latest` on every PR and push: `cargo fmt --check` + `just buck2-clippy` + `just build-rs` + `just build-server-rs` + `just test-rs` + target/test manifest checks. It uses the remote cache for trusted PRs/pushes.

The `buck2` job runs on `macos-14` (arm64) as an additional gate: it runs clippy + builds + tests all server crates, builds + validates the unsigned headless archive **in the release configuration** (`release_build=1`, real version/SHA — the same config the release-prepare jobs use), and checks target/test manifests. It **is** in the `release` job's `needs` list — it is a release gate. PR runs skip the release-config archive build + validation (those steps carry `if: github.event_name != 'pull_request'`); they run on tags, non-release main pushes, and manual dispatches, whose release-config archive actions warm the remote cache for the tag-triggered release-prepare jobs (first tag run compiles cold; later runs and retries hit the cache). PRs still run clippy + dev build/test + manifest checks.

### Clippy via Buck2

Clippy runs through Buck2's built-in `[clippy.json]` subtargets on every `rust_library` and `rust_binary` target. The Rust toolchain (`toolchains/BUCK`) sets `deny_lints = ["warnings"]`, matching `cargo clippy -- -D warnings`. Clippy results are cacheable — they participate in the remote action cache like regular builds. The `just buck2-clippy` recipe builds all `[clippy.json]` subtargets for the five server library crates. `cargo fmt --check` remains a fast Cargo command (no cache benefit).

### What the `buck2` CI job does

1. Installs pinned Buck2 + Reindeer via `scripts/ci/install-buck2-ci.sh`.
2. Connects to Tailscale and generates `.buckconfig.local` (trusted runs only).
3. Runs clippy on all server library crates via `just buck2-clippy`.
4. Builds all server crates + the `pantoken-server` binary via `just build-rs` / `just build-server-rs`.
5. Runs all 13 Buck2 test targets via `just test-rs`.
6. Builds the unsigned headless archive in the release configuration (via `.buckconfig.ci` with `release_build = 1` + `--config-file`). **Skipped on PRs** (`if: github.event_name != 'pull_request'`); runs on tags, non-release main pushes, and manual dispatches.
7. Validates the archive via `just validate-archive-rs-ci` (passes `--config-file .buckconfig.ci`, so the sh_test validates the release-config archive — plain `validate-archive-rs` would rebuild + validate a dev-config archive). Also skipped on PRs, alongside the build.
8. Runs target manifest and test inventory checks.

### Remote cache in CI

Trusted PRs (same-repo) and pushes connect to Tailscale via `tailscale/github-action`
and generate `.buckconfig.local` from the `BUCK2_CACHE_HOST` secret. Buck2
auto-reads `.buckconfig.local` for cache queries/uploads.

**Fork PR handling:** Fork PRs do not have access to `TS_AUTH_KEY` or
`BUCK2_CACHE_HOST` secrets. The Tailscale and cache config steps are gated on
`github.event.pull_request.head.repo.full_name == github.repository`. For fork
PRs, no `.buckconfig.local` is generated, so Buck2 uses local-only
execution automatically. This prevents cache poisoning.

**Required GitHub secrets** (operator must set before first CI run):
- `TS_AUTH_KEY` — Tailscale auth key (reusable ephemeral).
- `BUCK2_CACHE_HOST` — Mac mini's tailnet hostname running bazel-remote.

The CI job functions without these secrets — it falls back to local execution.

### Release builds in CI

The tag-triggered `release-prepare` (macOS arm64) and `release-prepare-linux`
(x86_64) jobs build the signed headless artifacts entirely via Buck2:
`pnpm exec tsx scripts/headless/build.ts --builder buck2 --tag <tag>`
(plus `--target x86_64-unknown-linux-gnu` on Linux). `build.ts` writes
`.buckconfig.ci` (version, build SHA, `release_build=1`), builds
`//:pantoken_headless_unsigned` and
`//server/pantoken-tar-validate:pantoken_tar_validate`, copies them to the
release asset paths (`target/release/headless/<asset>`,
`target/release/pantoken-tar-validate`), then signs with minisign, verifies,
and assembles metadata — signing secrets never enter cacheable Buck2 actions.

Both jobs connect to the Tailscale remote cache (secrets-gated, skips
gracefully), so release-config actions cached by the `buck2` gate job are
reused across tags once populated. Warmth comes from the gate's non-release
main pushes and tags (PRs skip the release-config build): the last dev main
push before a release warms the third-party release-config actions, while the
tag run itself still recompiles the SHA-embedded server crate (inherent to
embedding `PANTOKEN_BUILD_SHA` as a rustc env).
`release-prepare` additionally runs
`just validate-archive-rs-ci` after the build as a hermetic gate against the
release-config archive.

`release-prepare` connects to Tailscale and writes `.buckconfig.local`
*before* `publish.ts` runs its Tauri build: tauri's `beforeBuildCommand`
invokes `build-hub.ts`, whose buck2 command starts the job's daemon, and a
daemon started before the cache config exists would freeze an empty RE
config (see "Configuration"). A `buck2 kill` step before the headless build
restarts the daemon with the current config as a defense against step-order
regressions.

The old informational Buck2⇄Cargo parity comparison step was removed from CI
with this cutover. `scripts/ci/buck2-parity-compare.sh` stays in-tree as a
local dev tool for manual Cargo-vs-Buck2 spot checks (structural comparison of
two archives; not a CI gate).

### Fallback exercise

A `workflow_dispatch` input `buck2_no_cache` forces local execution (no remote
cache). When set, the Tailscale and cache config steps are skipped. Buck2
runs without `.buckconfig.local`, so all commands use local-only execution.
This proves the gate completes without the remote cache.

## Ownership

Ownership is area-based and lightweight: Rust maintainers own `server/*/BUCK`; release/tooling maintainers own the root `BUCK`, `.buckconfig`, `toolchains/BUCK`, `reindeer.toml`, and `third-party/`; documentation maintainers own this policy document. Root, toolchain, and Reindeer configuration changes require one owner review and one reviewer familiar with Cargo/pnpm boundaries. Keep Buck2 changes reversible and update this policy when a supported boundary changes.
