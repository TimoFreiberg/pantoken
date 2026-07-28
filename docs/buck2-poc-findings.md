# Buck2 POC Findings

> **Decision gate: CONDITIONAL — not ready for broad adoption.**
> Buck2 successfully builds 4 of 5 server crates with affected-target execution
> and a checked-in dependency graph. The `pantoken-server` binary is blocked by
> an OpenSSL/ring native compilation issue that has no pure-Rust workaround.
> Recommendation: keep Buck2 as an additive experiment; do not promote until
> the OpenSSL dependency is eliminated or a hermetic native toolchain is provided.

## Overview

This POC evaluated Buck2 as an **additive** build system alongside the authoritative Cargo/pnpm
workflows and the existing Bazel POC. It covers all 5 `server-rs` Rust crates (4 build successfully),
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
- **OpenSSL** (Homebrew) — required for the `openssl-sys` build script.
  `OPENSSL_DIR=/opt/homebrew/opt/openssl@3` must be set for the server build.

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
| pantoken-server | ❌ | ❌ | ❌ | Blocked by OpenSSL/ring |

### POC blocker: OpenSSL/ring native compilation

The `pantoken-server` crate depends on `web-push` → `ece` → `openssl` → `ring`.
Neither `ece` 2.3.1 nor `web-push` 0.11.0 has a Rustls or pure-Rust backend — `backend-openssl`
is the only published backend. This means:

1. **`openssl-sys`** requires a build script that finds and validates system OpenSSL headers.
   The build script panics during `validate_headers` under Buck2's sandboxed buildscript execution.
2. **`ring`** requires a build script that compiles C code (curve25519, etc.) via `cc-rs`.
   The C compilation fails in Buck2's sandbox due to header expansion issues.

**Workaround attempted:** Setting `OPENSSL_DIR`, `OPT_LEVEL`, `DEBUG` env vars in fixups.
The `openssl-sys` build script runs but panics on header validation. The `ring` build script
runs but fails on C compilation.

**Root cause:** These are native C dependencies that require ambient system libraries and
compilers — inherently non-hermetic. Cargo handles this because it runs build scripts with
full host access. Buck2's sandboxed `buildscript_run` isolates the build script from the host
environment.

**Resolution paths (future work):**
- Fork `ece` to use a pure-Rust crypto backend (ring/RustCrypto)
- Fork `web-push` to use `hyper-rustls` instead of `hyper-tls`
- Provide a hermetic native toolchain for Buck2 that includes OpenSSL headers
- Document the OpenSSL dependency as a known non-hermetic boundary (like Bazel's approach)

## Reindeer fixups

The following fixups were required for the 353 third-party crates:

| Fixup | Crates | Reason |
|-------|--------|--------|
| `buildscript.run = true` | anyhow, libc, getrandom, ring, openssl, openssl-sys, serde, etc. | Build scripts set cfg flags or generate code |
| `buildscript.run = false` + `cfgs` | serde_json, rustix | Build script sets cfg flags that can be hardcoded for aarch64-apple-darwin |
| `extra_srcs` | axum (docs/**), bstr (fsm/**), cc (.c file), ring (data/**), rustls-pki-types (data/**), rustls-webpki (data/**), tower-http (README.md), aho-corasick (src/**/*.md) | `include_bytes!`/`include_str!` for non-.rs files not discovered by Reindeer |
| `[buildscript.run] env` | ring (OPT_LEVEL, DEBUG, NUM_JOBS), openssl-sys (OPENSSL_DIR, OPENSSL_INCLUDE_DIR, OPENSSL_LIB_DIR) | Build scripts need env vars that Cargo normally sets |
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

## Comparison with Bazel POC

| Aspect | Bazel | Buck2 | Notes |
|--------|-------|-------|-------|
| Server crates build | ✅ All 5 | ⚠️ 4 of 5 | Buck2 blocked by OpenSSL/ring |
| Dependency ingestion | crate_universe | Reindeer | Both require manual fixups |
| Deterministic archive | rules_pkg | Python genrule | Buck2 hand-rolls the archive |
| Build script support | cargo_build_script | buildscript_run | Both require env fixes |
| CARGO_MANIFEST_DIR | Source patch + env override | env/resources + $(location) | Similar approach |
| Vendored deps size | N/A (crate_universe) | 335MB (Reindeer vendor) | Buck2 checks in vendored sources |
| Clean build | 32s | ~45s | Buck2 slower (more crates to compile) |
| Warm build | <1s | <1s | Both use action cache |
| Incremental | 16 actions (surgical) | Similar (affected-target) | Both track dependencies precisely |

## Decision gate: CONDITIONAL

| Criterion | Assessment | Verdict |
|-----------|------------|---------|
| Reproducibility | ⚠️ Pinned toolchain, locked deps, deterministic archive — but OpenSSL/ring builds are non-hermetic | Conditional |
| Affected-target execution | ✅ Only dependents of changed files rebuild | Pass |
| Test/artifact caching | ⚠️ Action cache works for 4 crates; archive assembly not yet tested end-to-end | Conditional |
| Cross-workspace/CI reuse | ⚠️ Buck2 cache works; but 335MB vendored deps is a maintenance burden | Conditional |
| Maintainability | ⚠️ Reindeer fixups are complex; OpenSSL blocker requires resolution | Conditional |

**Recommendation:** Do not promote Buck2. The OpenSSL/ring native compilation blocker
prevents building the server binary. Reindeer fixups are complex and fragile. The 335MB
vendored dependency tree is a maintenance burden. Cargo remains authoritative.

## Rollback

Buck2 is fully additive — removing it requires only:
1. Delete `buck-out/`, `.buckconfig`, `.buckroot`, `BUCK`, `toolchains/`, `buck2/`, `scripts/buck2/`
2. Delete `third-party/`, `reindeer.toml`
3. Delete `server-rs/*/BUCK` files
4. Revert the `reqwest` feature change in `Cargo.toml` (optional — it's an improvement)
5. Run `cargo update` to regenerate `Cargo.lock`

Cargo, pnpm, and Bazel workflows are completely unaffected.
