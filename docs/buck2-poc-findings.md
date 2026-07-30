# Buck2 Findings

> **Decision gate: PROMOTED — primary build/test system.**
> Buck2 is now the primary local build+test system for Rust. `just check-rs` uses
> buck2 for build+test; `just check-rs-cargo` is the Cargo fallback. The dev server
> and desktop hub build via buck2 by default (`PANTOKEN_BUILD_SYSTEM=cargo` escape
> hatch). The `rust-server` CI job uses buck2 on Linux; the `buck2` job runs on
> macOS arm64. Releases remain Cargo-authored (buck2 parity comparison only).
> The `buck2` CI job builds all 5 server crates, tests, archives, and
> runs manifest checks on every PR/push. Parity comparison runs on every
> release. Cargo remains authoritative for releases.
> See `docs/buck2-policy.md` for the foundation policy and CI integration.

## Overview

This evaluation assessed Buck2 as the **primary** build system alongside the Cargo/pnpm
workflows. It covers all 5 `server-rs` Rust crates (all 5 build successfully),
Reindeer-generated third-party dependencies, and unsigned headless archive assembly.
Cargo and pnpm remain the source of truth; Buck2 builds the same artifacts from the same sources.

## Prerequisites

- **Buck2** — pinned to revision `2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc`.
  Download from [GitHub releases](https://github.com/facebook/buck2/releases).
  Run `scripts/buck2/check-version.sh` to verify.
- **Reindeer** — pinned to commit `efe17c7bb0b547ed07d48111ebcbeea5fa42a904` from
  [facebookincubator/reindeer](https://github.com/facebookincubator/reindeer).
  Install: `cargo install --git https://github.com/facebookincubator/reindeer --rev efe17c7bb0b547ed07d48111ebcbeea5fa42a904 reindeer`
  Or download a prebuilt binary from [releases](https://github.com/facebookincubator/reindeer/releases)
  (closest tag: `v2026.07.27.00`).
- **Rust 1.97.1** (aarch64-apple-darwin) — via `rust-toolchain.toml`.

## POC target scope

- **Host-only `aarch64-apple-darwin`** — tested on macOS arm64.
- **x86_64-unknown-linux-gnu is excluded** — no pinned Linux cross toolchain/linker/sysroot.
  The existing Cargo/CI Linux artifact path is unchanged.

## How to run

```bash
just buck2-check          # verify Buck2/Reindeer/Rust versions
just buck2-build          # build all server-rs crates
just buck2-test           # run selected tests
just buck2-archive        # build unsigned headless archive
just buck2-measure        # run measurement script
```

## Build results

| Crate | Library | Binary | Tests | Notes |
|-------|---------|--------|-------|-------|
| pantoken-protocol | ✅ | — | ✅ | |
| pantoken-daemon-types | ✅ | — | ✅ | |
| pantoken-remote-layout | ✅ | — | ✅ | |
| pantoken-tar-validate | ✅ | ✅ | ✅ | |
| pantoken-server | ✅ | ✅ | ✅ | Resolved (Issue #119) |

### POC blocker: OpenSSL/ring native compilation — RESOLVED

The `pantoken-server` crate previously depended on `web-push` → `ece` → `openssl` → `ring`.
This is now resolved (Issue #119):

1. The `ece` RustCrypto fork (`third-party/ece-2.3.1-rustcrypto`) replaced
   the OpenSSL backend with pure RustCrypto (`p256`, `aes-gcm`, `hkdf`, `sha2`).
2. The `web-push` `hyper-client` feature was dropped; an in-tree
   `ReqwestWebPushClient` implements the `WebPushClient` trait over the existing
   reqwest (rustls) client — no `web-push` fork needed.
3. `ring` remains as the sole native C dependency (via `reqwest[rustls-tls]` →
   `rustls`). Its `cc`-based buildscript compiles under Buck2's sandbox with env
   fixups (`PATH`, `SDKROOT`, `DEVELOPER_DIR`) in `third-party/fixups/ring/fixups.toml`.
4. `OPENSSL_DIR` was removed from all `buck2-*` justfile recipes — openssl is no
   longer in the graph.

All other `-sys` crates (`core-foundation-sys`, `fsevent-sys`) are linkage-only
framework bindings with no C compilation.

## Reindeer fixups

The following fixups were required for the 353 third-party crates:

| Fixup | Crates | Reason |
|-------|--------|--------|
| `buildscript.run = true` | anyhow, libc, getrandom, ring, serde, etc. | Build scripts set cfg flags or generate code |
| `buildscript.run = false` + `cfgs` | serde_json, rustix | Build script sets cfg flags that can be hardcoded for aarch64-apple-darwin |
| `extra_srcs` | axum (docs/**), bstr (fsm/**), cc (.c file), ring (data/**), rustls-pki-types (data/**), rustls-webpki (data/**), tower-http (README.md), aho-corasick (src/**/*.md) | `include_bytes!`/`include_str!` for non-.rs files not discovered by Reindeer |
| `[buildscript.run] env` | ring (OPT_LEVEL, DEBUG, NUM_JOBS, PATH, SDKROOT, DEVELOPER_DIR) | Build script needs env vars that Cargo normally sets; PATH/SDKROOT/DEVELOPER_DIR for sandboxed `cc`-based C compilation |
| `omit_features` + `features` | reqwest (removed default-tls, added rustls-tls) | Eliminate OpenSSL dependency from reqwest (applied in Cargo.toml) |
| `cargo_env = true` | (global in reindeer.toml) | Provide CARGO_PKG_* env vars that build scripts read via env!() |

### reqwest → rustls-tls switch

The workspace `Cargo.toml` was changed from:
```toml
reqwest = { version = "0.12", features = ["json", "stream"] }
```
to:
```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls"] }
```

This eliminates `native-tls`, `hyper-tls`, `tokio-native-tls`, `openssl`, and `openssl-sys` from
reqwest's dependency tree. Cargo builds are unaffected (the API is identical). This is a permanent
improvement, not just a Buck2 workaround.

## Deterministic archive assembly

The unsigned headless archive uses a Python-based assembler (`scripts/buck2/assemble-archive.py`)
instead of `rules_pkg` (which doesn't exist for Buck2). The assembler produces a deterministic
`.tar.gz` with:
- Sorted paths
- Fixed mtime (epoch 0)
- Fixed uid/gid (0/0) and uname/gname (root/root)
- Fixed file modes (0755 for executables, 0644 for regular files)
- Deterministic gzip header (no timestamp, no filename, compression level 9)

**Status: PASSING.** The archive target (`//:pantoken_headless_unsigned`) builds
successfully and `just buck2-validate-archive` passes end-to-end (Issue #120).
The sh_test runs both safety validation (`pantoken-tar-validate`) and content
validation (gzip magic bytes, VERSION/BUILD_SHA format, executable permissions).
Reproducibility was verified via `scripts/buck2/verify-reproducibility.sh` —
two independent builds produce byte-for-byte identical sha256 (Issue #120).
The staging script handles Buck2's filegroup materialization (source files are
nested at their project-relative paths within the filegroup output directory).
Requires `just build-client` to have been run first (Buck2 consumes pre-built
client/dist, it does not invoke pnpm/Vite).


## Decision gate: PROMOTED — primary build/test system

Buck2 is now the primary build+test system. The `rust-server` CI job runs on
`ubuntu-latest` and uses buck2 for build+test (with remote cache for trusted
runs). The `buck2` CI job runs on `macos-14`, builds all 5 server-rs crates,
runs all 13 test targets, builds + validates the unsigned headless archive, and
checks target/test manifests. `just check-rs` uses buck2 locally; the dev server
and desktop hub build via buck2 by default.

Parity comparison runs on every release (`release-prepare` job): the unsigned
headless archive is built via both Buck2 and Cargo, then structurally compared.
The Cargo artifact remains the one that gets signed and published.

The `buck2` job is NOT in the `release` job's `needs` list — it gates merges but
does not block releases. The parity comparison is `continue-on-error: true`.

| Criterion | Assessment | Verdict |
|-----------|------------|---------|
| Reproducibility | ✅ Pinned toolchain, locked deps, deterministic archive; ring is the sole native C dep with sandboxed `cc` build (platform-conditional env fixups) | Pass |
| Affected-target execution | ✅ Only dependents of changed files rebuild | Pass |
| Test/artifact caching | ✅ Action cache works for all 5 crates; archive assembly passing | Pass |
| CI integration | ✅ `rust-server` job uses buck2 on Linux; `buck2` job on macOS; remote cache for trusted runs | Pass |
| Parity comparison | ✅ Structural comparison in release-prepare (informational, non-blocking) | Pass |
| Cross-workspace/CI reuse | ✅ Remote cache via Tailscale + bazel-remote for trusted PRs/pushes | Pass |
| Maintainability | ✅ Reindeer fixups use cfg-based platform sections; ring fixup is platform-portable | Pass |

**Recommendation:** Buck2 is promoted to the primary build+test system. Cargo
remains the fallback (`just check-rs-cargo`, `PANTOKEN_BUILD_SYSTEM=cargo`) and
the release-authoritative path. Releases are Cargo-authored; buck2 parity
comparison is informational.

## Timing comparison

_Captured: 2026-07-30 on Darwin 25.5.0 (arm64), aarch64-apple-darwin.
Rust 1.97.1, Buck2 2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc._

_These are machine-specific comparison points, not a performance program.
The Cargo baseline was captured 2026-07-27 on the same M1 Pro (see
[`docs/toolchain-baseline.md`](toolchain-baseline.md)). Re-capture on the same
machine for like-for-like comparison. Note: the Cargo baseline values below are
hardcoded in `scripts/buck2/measure-poc.sh`; they were captured in a separate
session and may differ from a fresh Cargo capture._

### Buck2 timings

| Metric | Time | Notes |
|--------|------|-------|
| Cold build | 0.95s | Clean buck-out, 4 non-binary server crates |
| Warm build | 0.02s | No changes, action cache hit |
| Incremental (1 file) | 0.02s | Content edit to `pantoken-protocol/src/lib.rs` |
| Test run | 0.04s | 5 test targets |
| Archive build | 0.03s | Unsigned headless archive |
| Cross-workspace (cache) | 0.76s | After `buck2 clean`, action cache cold but deps cached |

The cross-workspace timing measures remote action-cache reuse after a local
`buck2 clean` (local buck-out cleared, but the action cache still holds results
from the prior build). It is not literal cross-workspace isolation — two
independent workspaces sharing the same remote REAPI store would see similar
reuse. The metric demonstrates that the remote action cache survives a local
clean, which is the mechanism CI relies on for PR-to-PR reuse.

### Cargo vs Buck2 comparison

| Metric | Buck2 | Cargo baseline |
|--------|-------|----------------|
| Cold build | 0.95s | 11.4s |
| Warm build | 0.02s | 8.4s |
| Incremental | 0.02s | 2.5s |
| Test run | 0.04s | N/A |

The Buck2 timings are dramatically lower because the action cache was warm from
prior CI/local builds — the cold build reuses cached action results from the
remote REAPI store rather than compiling from scratch. A truly cold Buck2 run
(no action cache, no local buck-out) would be comparable to or slower than
Cargo's cold build. The comparison is most meaningful for the **incremental**
and **warm** rows, where Buck2's affected-target execution avoids re-linking
unchanged crates.

## Cargo⇄Buck2 test parity mapping

Every Cargo test binary for the 5 server-rs crates has a Buck2 `rust_test` counterpart:

| Crate | Cargo test binary(s) | Buck2 target | Notes |
|-------|---------------------|--------------|-------|
| pantoken-protocol | `fold_corpus` | `fold_corpus_tests` | Uses `PANTOKEN_FOLD_CORPUS_DIR` run_env |
| pantoken-daemon-types | `target_version_test`, `daemon_types_roundtrip`, `schema_inventory_test` | same names | `schema_inventory_test` needs `src/lib.rs` + fixture in `srcs` (include_str!) |
| pantoken-remote-layout | inline `#[cfg(test)]` | `unit_tests` | `crate = ":lib"` analogue via duplicated `srcs` |
| pantoken-tar-validate | inline `#[cfg(test)]` | `unit_tests` | Same pattern |
| pantoken-server | inline `#[cfg(test)]` | `server_lib_unit_tests` | `crate = "pantoken_server"` enables `cfg(test)`; `real_shell` test skips under sandbox (HOME not absolute) |
| pantoken-server | `corpus` | `corpus_tests` | `PANTOKEN_CORPUS_DIR`/`PANTOKEN_CANON_PARITY_DIR` run_env |
| pantoken-server | `live_path` | `live_path_tests` | `PANTOKEN_CORPUS_DIR` run_env; Unix socket tests |
| pantoken-server | `websocket_adapter_contract_tests` | `websocket_adapter_tests` | Loopback networking |
| pantoken-server | `stdio_adapter_contract_tests` | `stdio_adapter_tests` | `PANTOKEN_SERVER_BIN` env injection |
| pantoken-server | `resume_and_recovery_tests` | `resume_and_recovery_tests` | `PANTOKEN_SERVER_BIN` env injection |
| pantoken-server | `remote_runtime_integration_tests` | `remote_runtime_tests` | `PANTOKEN_SERVER_BIN` env injection |

Pre-existing Cargo test failures unrelated to Buck2 (also fail under `cargo nextest run`):
- `polytoken::event_map::tests::message_complete_with_turn_error_run_failed_and_clears_error`
- `polytoken::event_map::tests::streaming_unretried_error_fails_the_run`
- `stdio_proxy_bootstraps_declared_server_binary` (server binary not found at expected path)

## Rollback

Buck2 is fully additive — removing it requires only:
1. Delete `buck-out/`, `.buckconfig`, `.buckroot`, `BUCK`, `toolchains/`, `buck2/`, `scripts/buck2/`
2. Delete `third-party/BUCK`, `third-party/fixups/`, `third-party/ece-2.3.1-rustcrypto/`, `reindeer.toml`
3. Delete `server-rs/*/BUCK` files
4. Revert the `reqwest` feature change in `Cargo.toml` (optional — it's an improvement)
5. Revert the `[patch.crates-io]` ece path in `Cargo.toml` if the ece fork was deleted
6. Run `cargo update` to regenerate `Cargo.lock`

Note: `third-party/vendor/` is gitignored (no deletion needed). Cargo and pnpm workflows are completely unaffected.
