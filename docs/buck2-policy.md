# Buck2 policy

Buck2 is the additive, explicitly non-authoritative build system. Cargo remains authoritative for Rust and pnpm remains authoritative for JavaScript. The policy is intentionally narrow: it defines the supported Buck2 foundation without requiring a release migration.

## Pins and ownership

The supported Buck2 revision is `2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc`, verified by `buck2/bootstrap.sh` and `scripts/buck2/check-version.sh`. Reindeer must be installed from commit `efe17c7bb0b547ed7d48111ebcbeea5fa42a904`; the check script verifies that Reindeer is available, while the installer command or reviewed installation record is responsible for confirming this revision. Rust is pinned to 1.97.1 for `aarch64-apple-darwin`, matching `rust-toolchain.toml`.

Update these pins together: edit the pin in `buck2/bootstrap.sh` and `scripts/buck2/check-version.sh`, reinstall the pinned Buck2 binary, run `just buck2-check`, then run `just buck2-build`, `just buck2-test`, and the Cargo checks. Keep the pin and generated dependency changes in one reversible diff.

## Supported platforms

macOS arm64 (`aarch64-apple-darwin`) is the primary and only tested target. Linux amd64 is a follow-up: no pinned cross toolchain, linker, or sysroot exists yet. Windows is unsupported in this phase.

## Boundary and non-goals

The initial boundary is deterministic `server-rs` Rust libraries, binaries, tests, and unsigned headless archive inputs. Buck2 consumes declared frontend outputs only; it does not run Vite, JavaScript tests, or Playwright. It does not package Tauri, sign artifacts, access credentials, deploy, or publish.

The `pantoken-server` binary is a known gap: `ece → openssl → ring` native compilation currently fails under Buck2 sandboxing. See the “No OpenSSL policy” decision in `docs/DECISIONS.md`. Cargo and pnpm direct workflows must remain usable.

## Target conventions

Use package-local, descriptive `snake_case` labels. Public library, binary, and archive interfaces use `visibility = ["PUBLIC"]`; build helpers and generated intermediates use `visibility = []`. `rust_library`, `rust_binary`, and `rust_test` declare every `srcs`, `deps`, and runtime `data`/`resources`. `sh_test` declares its scripts and executable/data labels. Keep targets near their sources.

Buck2 `rust_test` has no `data` attribute; test data files are declared via `resources` and referenced in `run_env` with `$(location)`. The `expected-targets.toml` manifest (`buck2/expected-targets.toml`) validates that the Buck2 graph exactly matches expectations; `just buck2-targets-check` fails on omissions or unexpected targets.

## Reindeer and dependency updates

`Cargo.toml` and `Cargo.lock` are the Rust dependency source of truth. `third-party/Cargo.toml` is a dummy workspace crate representing the dependency closure of the five `server-rs` crates. After a Rust dependency change, run the normal Cargo update/check flow, then `just buck2-deps-regenerate` (which runs `reindeer vendor` and `reindeer buckify`). Review the generated `third-party/BUCK` and `third-party/vendor/` diff before committing. `just buck2-deps-check` verifies that regeneration produces no diff.

Fixups live in `third-party/fixups/<crate>/fixups.toml`, Reindeer's default location. `reindeer.toml` sets `cargo_env = true` to provide `CARGO_PKG_*` environment variables. Generated vendored sources and the generated BUCK file are checked in and reviewed as a diff; they are never silently regenerated without review. `Cargo.lock` and `pnpm-lock.yaml` remain authoritative and are not replaced by Reindeer output. Review generated BUCK files separately from application lockfile changes, but use one documented update workflow and a reversible diff.

## Hermeticity and path stability

Buck2’s sandboxed `buildscript_run` isolates build scripts from the host environment. No target may inherit ambient environment, credentials, or host paths. Tests that need environment variables set them explicitly via `run_env`. `CARGO_MANIFEST_DIR` is set through the target `env` attribute, not inherited from the host.

The `run-reindeer.sh` wrapper sets the absolute `manifest_path` dynamically to avoid hardcoding checkout-specific paths. Generated metadata, including `third-party/BUCK`, must be free of machine- or workspace-local absolute paths; `CARGO_MANIFEST_DIR` values use relative paths such as `vendor/adler2-2.0.1`. `just buck2-test-inventory-check` validates the test inventory against expected targets and rejects undeclared entries. `buck2/test-inventory.toml` documents environment allowlist/clears, socket usage, temp root, and network policy for every test target.

## Ownership

Ownership is area-based and lightweight: Rust maintainers own `server-rs/*/BUCK`; release/tooling maintainers own the root `BUCK`, `.buckconfig`, `toolchains/BUCK`, `reindeer.toml`, and `third-party/`; documentation maintainers own this policy document. Root, toolchain, and Reindeer configuration changes require one owner review and one reviewer familiar with Cargo/pnpm boundaries. Keep Buck2 changes reversible and update this policy when a supported boundary changes.
