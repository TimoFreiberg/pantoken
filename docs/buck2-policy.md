# Buck2 policy

Buck2 is the additive, explicitly non-authoritative build system. Cargo remains authoritative for Rust and pnpm remains authoritative for JavaScript. The policy is intentionally narrow: it defines the supported Buck2 foundation without requiring a release migration.

## Pins and ownership

The supported Buck2 revision is `2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc`, verified by `buck2/bootstrap.sh` and `scripts/buck2/check-version.sh`. Reindeer must be installed from commit `efe17c7bb0b547ed7d48111ebcbeea5fa42a904`; the check script verifies that Reindeer is available, while the installer command or reviewed installation record is responsible for confirming this revision. Rust is pinned to 1.97.1 for `aarch64-apple-darwin`, matching `rust-toolchain.toml`.

Update these pins together: edit the pin in `buck2/bootstrap.sh` and `scripts/buck2/check-version.sh`, reinstall the pinned Buck2 binary, run `just buck2-check`, then run `just buck2-build`, `just buck2-test`, and the Cargo checks. Keep the pin and generated dependency changes in one reversible diff.

## Supported platforms

macOS arm64 (`aarch64-apple-darwin`) is the primary and only tested target. Linux amd64 is a follow-up: no pinned cross toolchain, linker, or sysroot exists yet. Windows is unsupported in this phase.

## Boundary and non-goals

The initial boundary is deterministic `server-rs` Rust libraries, binaries, tests, and unsigned headless archive inputs. Buck2 consumes declared frontend outputs only; it does not run Vite, JavaScript tests, or Playwright. It does not package Tauri, sign artifacts, access credentials, deploy, or publish.

All 5 server-rs crates build successfully under Buck2, including the `pantoken-server` binary (the OpenSSL gap was resolved in Issue #119 via the ece RustCrypto fork and reqwest rustls-tls switch). See the “No OpenSSL policy” decision in `docs/DECISIONS.md`. Cargo and pnpm direct workflows must remain usable.

## Target conventions

Use package-local, descriptive `snake_case` labels. Public library, binary, and archive interfaces use `visibility = ["PUBLIC"]`; build helpers and generated intermediates use `visibility = []`. `rust_library`, `rust_binary`, and `rust_test` declare every `srcs`, `deps`, and runtime `data`/`resources`. `sh_test` declares its scripts and executable/data labels. Keep targets near their sources.

Buck2 `rust_test` has no `data` attribute; test data files are declared via `resources` and referenced in `run_env` with `$(location)`. The `expected-targets.toml` manifest (`buck2/expected-targets.toml`) validates that the Buck2 graph exactly matches expectations; `just buck2-targets-check` fails on omissions or unexpected targets.

## Reindeer and dependency updates

`Cargo.toml` and `Cargo.lock` are the Rust dependency source of truth. `third-party/Cargo.toml` is a dummy workspace crate representing the dependency closure of the five `server-rs` crates. After a Rust dependency change, run the normal Cargo update/check flow, then `just buck2-deps-regenerate` (which runs `reindeer vendor` and `reindeer buckify`). Review the generated `third-party/BUCK` and `third-party/vendor/` diff before committing. `just buck2-deps-check` verifies that regeneration produces no diff.

Fixups live in `third-party/fixups/<crate>/fixups.toml`, Reindeer's default location. `reindeer.toml` sets `cargo_env = true` to provide `CARGO_PKG_*` environment variables. Generated vendored sources and the generated BUCK file are checked in and reviewed as a diff; they are never silently regenerated without review. `Cargo.lock` and `pnpm-lock.yaml` remain authoritative and are not replaced by Reindeer output. Review generated BUCK files separately from application lockfile changes, but use one documented update workflow and a reversible diff.

## Hermeticity and path stability

Buck2’s sandboxed `buildscript_run` isolates build scripts from the host environment. No target may inherit ambient environment, credentials, or host paths. Tests that need environment variables set them explicitly via `run_env`. `CARGO_MANIFEST_DIR` is set through the target `env` attribute, not inherited from the host.

The `run-reindeer.sh` wrapper sets the absolute `manifest_path` dynamically to avoid hardcoding checkout-specific paths. Generated metadata, including `third-party/BUCK`, must be free of machine- or workspace-local absolute paths; `CARGO_MANIFEST_DIR` values use relative paths such as `vendor/adler2-2.0.1`. `just buck2-test-inventory-check` validates the test inventory against expected targets and rejects undeclared entries. `buck2/test-inventory.toml` documents environment allowlist/clears, socket usage, temp root, and network policy for every test target.

## Remote cache (opt-in)

Buck2 has no local disk cache (`--disk_cache` equivalent); the daemon is
in-memory only, so `buck2 kill` causes a full rebuild. A shared `bazel-remote`
instance on the always-on Mac mini provides cross-workspace and post-restart
action-result reuse via the REAPI content-addressable store (CAS) + action
cache (AC).

### Configuration

Remote cache is **opt-in**. The repo is public, so the Tailscale cache address
lives in a gitignored `.buckconfig.remote-cache`, not in `.buckconfig`. Copy
`.buckconfig.remote-cache.example` to `.buckconfig.remote-cache` and fill in the real
Tailscale address. Use the `just buck2-*-cached` recipes or pass
`--config-file .buckconfig.remote-cache` to `buck2` directly.

The local config sets:
- `[buck2_re_client]` — engine/CAS/AC addresses, `tls = false` (WireGuard
  provides transport security via Tailscale), `instance_name = buck2`.
- `[build] execution_platforms = toolchains//platforms:remote_cache` — a custom
  execution platform that sets `CommandExecutorConfig(local_enabled=True,
  remote_enabled=False, remote_cache_enabled=True, allow_cache_uploads=True)`.

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
- Untrusted PRs: fork PRs do not generate `.buckconfig.remote-cache`, so
  Buck2 uses local-only execution automatically. This prevents cache
  poisoning — untrusted code never writes to the shared cache. Same-repo
  PRs and pushes connect to Tailscale and use the remote cache.

## CI integration

Buck2 runs in CI as an **additive gate** alongside the existing Cargo/pnpm checks.
The `buck2` job in `.github/workflows/ci.yml` runs on `macos-14` (arm64) on every
PR and push. It is **not** in the `release` job's `needs` list — the Cargo path
remains authoritative for releases.

### What the `buck2` CI job does

1. Installs pinned Buck2 + Reindeer via `scripts/ci/install-buck2-ci.sh`.
2. Builds `client/dist` (Buck2 consumes pre-built frontend output).
3. Connects to Tailscale and generates `.buckconfig.remote-cache` (trusted runs only).
4. Builds all server-rs crates + the `pantoken-server` binary via `just buck2-build` / `just buck2-build-server`.
5. Runs all 13 Buck2 test targets via `just buck2-test`.
6. Builds the unsigned headless archive with real `PANTOKEN_VERSION` and `PANTOKEN_BUILD_SHA` from CI env (via `.buckconfig.ci` + `--config-file`).
7. Validates the archive via `just buck2-validate-archive`.
8. Runs target manifest and test inventory checks.

### Remote cache in CI

Trusted PRs (same-repo) and pushes connect to Tailscale via `tailscale/github-action`
and generate `.buckconfig.remote-cache` from the `BUCK2_CACHE_HOST` secret. Buck2
then uses `--config-file .buckconfig.remote-cache` for cache queries/uploads.

**Fork PR handling:** Fork PRs do not have access to `TS_AUTH_KEY` or
`BUCK2_CACHE_HOST` secrets. The Tailscale and cache config steps are gated on
`github.event.pull_request.head.repo.full_name == github.repository`. For fork
PRs, no `.buckconfig.remote-cache` is generated, so Buck2 uses local-only
execution automatically. This prevents cache poisoning.

**Required GitHub secrets** (operator must set before first CI run):
- `TS_AUTH_KEY` — Tailscale auth key (reusable ephemeral).
- `BUCK2_CACHE_HOST` — Mac mini's tailnet hostname running bazel-remote.

The CI job functions without these secrets — it falls back to local execution.

### Parity comparison in release-prepare

The `release-prepare` CI job (tag-triggered) includes additional Buck2 steps
that build the unsigned headless archive via Buck2 and compare it structurally
with the Cargo-built archive using `scripts/ci/buck2-parity-compare.sh`. The
comparison checks file listing, executable permissions, VERSION content,
BUILD_SHA content, index.html content, gzip magic, and binary sizes.

The parity comparison uses `continue-on-error: true` — it is informational and
does not block the release. The Cargo artifact is the one that gets signed and
published; the Buck2 archive is discarded.

### Fallback exercise

A `workflow_dispatch` input `buck2_no_cache` forces local execution (no remote
cache). When set, the Tailscale and cache config steps are skipped, and the
build/test steps use local-only `just` recipes. This proves the gate completes
without the remote cache. The existing Cargo/pnpm jobs (`rust-server`,
`web-check`, `web-e2e`, `desktop`) are the non-Buck2 fallback and remain
unchanged.

## Ownership

Ownership is area-based and lightweight: Rust maintainers own `server-rs/*/BUCK`; release/tooling maintainers own the root `BUCK`, `.buckconfig`, `toolchains/BUCK`, `reindeer.toml`, and `third-party/`; documentation maintainers own this policy document. Root, toolchain, and Reindeer configuration changes require one owner review and one reviewer familiar with Cargo/pnpm boundaries. Keep Buck2 changes reversible and update this policy when a supported boundary changes.
