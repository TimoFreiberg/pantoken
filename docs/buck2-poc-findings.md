# Buck2 POC Findings

> **Decision gate: CONDITIONAL — not ready for broad adoption.**
> The previous foundation has been removed; Buck2 is now the sole additive build system.
> Buck2 successfully builds all 5 server crates with affected-target execution
> and a checked-in dependency graph. The unsigned headless archive assembles
> deterministically and passes safety + content validation.
> See `docs/buck2-policy.md` for the foundation policy.

## Overview

This POC evaluated Buck2 as the **sole additive** build system alongside the authoritative Cargo/pnpm
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

1. The `ece` RustCrypto fork (`third-party/vendor/ece-2.3.1-rustcrypto`) replaced
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


## Decision gate: CONDITIONAL — all 5 crates build, archive + reproducibility verified

| Criterion | Assessment | Verdict |
|-----------|------------|---------|
| Reproducibility | ✅ Pinned toolchain, locked deps, deterministic archive; ring is the sole native C dep with sandboxed `cc` build | Pass |
| Affected-target execution | ✅ Only dependents of changed files rebuild | Pass |
| Test/artifact caching | ✅ Action cache works for all 5 crates; archive assembly passing | Pass |
| Cross-workspace/CI reuse | ⚠️ Buck2 cache works; but 335MB vendored deps is a maintenance burden | Conditional |
| Maintainability | ⚠️ Reindeer fixups are complex but stable; ring fixup requires platform-specific env | Conditional |

**Recommendation:** Do not promote Buck2 to authoritative CI yet. All 5 crates
build and all test targets pass (3 pre-existing Cargo test failures are unrelated
to Buck2). The 335MB vendored dependency tree remains a maintenance burden.
Cargo remains authoritative.

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
2. Delete `third-party/`, `reindeer.toml`
3. Delete `server-rs/*/BUCK` files
4. Revert the `reqwest` feature change in `Cargo.toml` (optional — it's an improvement)
5. Run `cargo update` to regenerate `Cargo.lock`

Cargo and pnpm workflows are completely unaffected.
