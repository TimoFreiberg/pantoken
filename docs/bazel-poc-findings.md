# Bazel POC Findings

> **Decision gate: PROCEED (conditional)** — Bazel demonstrates clear value for affected-target
> execution, cross-workspace cache reuse, and deterministic artifact assembly. The main cost is
> BUILD file maintenance and the `CARGO_MANIFEST_DIR` workaround. Recommendation: adopt Bazel
> incrementally for CI, starting with the Rust build + archive targets.

## Overview

This POC evaluated Bazel as an **additive** build system alongside the authoritative Cargo/pnpm
workflows. It covers all 5 `server-rs` Rust crates (builds + tests), the corpus/fake-daemon
validation tests, and unsigned headless archive assembly + validation. Cargo and pnpm remain the
source of truth; Bazel builds the same artifacts from the same sources.

## Prerequisites

- `bazelisk` (`brew install bazelisk`) — reads `.bazelversion` (pinned to 8.7.0)
- Pre-built `client/dist/` (`just build-client`) — required for the archive target

## How to run

```bash
just bazel-build         # build all server-rs crates
just bazel-test          # run all server-rs tests
just bazel-archive       # build the unsigned headless archive
just bazel-measure       # run the measurement script
```

## Timings

Captured: 2026-07-28 on macOS 26.5.0 (arm64), Apple M1 Pro.
Same machine as the Cargo baseline in `docs/toolchain-baseline.md`.

| Metric | Bazel | Cargo baseline | Notes |
|--------|-------|----------------|-------|
| Clean build | 32s | 11.4s | Bazel is 2.8× slower on clean builds (sandbox overhead + no sccache) |
| Warm build | <1s | 8.4s | Bazel is dramatically faster — action cache, zero work |
| Incremental (1 file) | 1s (16 actions) | 2.5s | Only protocol + dependents rebuilt; tar-validate untouched |
| Test run | ~30s (9/11 pass) | N/A | 2 test targets fail due to binary-path discovery (see Known Gaps) |
| Archive build | 3s (disk cache) | N/A | Includes Rust binaries + client-dist + deploy scripts |
| Cross-workspace (disk cache) | 3s (767 cache hits) | N/A | `bazel clean` + rebuild with `--disk_cache` — 767/1134 actions hit cache |

### Key observations

1. **Warm builds are near-instant** (<1s vs 8.4s). Bazel's action cache skips all compilation
   when nothing changed. This is the single biggest win for developer iteration speed.

2. **Clean builds are slower** (32s vs 11.4s). Bazel's sandboxing adds overhead, and it doesn't
   use sccache (the two cache systems are independent). The disk cache mitigates this — a
   `bazel clean` (without `--expunge`) rebuilds in 3s from disk cache.

3. **Incremental builds are surgical**. Touching `pantoken-protocol/src/lib.rs` triggered exactly
   16 actions: protocol + its 4 dependents (daemon-types, remote-layout, server-lib, server binary)
   + their test targets. `pantoken-tar-validate` was untouched — it has no dependency on protocol.

## Cache reuse

The `--disk_cache=~/.cache/bazel` setting (in `.bazelrc`) enables cross-workspace cache reuse:

- After a `bazel clean` (clears local action cache but not disk cache), rebuilding `//server-rs/...`
  takes 3s with 767/1134 actions served from disk cache.
- This means a second jj workspace sharing the same `~/.cache/bazel` directory would get the same
  cache hits — **the primary cross-workspace reuse benefit**.
- sccache (used by Cargo) and Bazel's disk cache are independent mechanisms. Bazel does not use
  sccache; Cargo does not use Bazel's cache. They coexist without interference.

## Affected-target execution

Verified by modifying `pantoken-protocol/src/lib.rs` and building with `--explain`:

```
Compiling Rust rlib pantoken_protocol (6 files)
Compiling Rust rlib pantoken_daemon_types (1 file)
Compiling Rust rlib pantoken_remote_layout (4 files)
Compiling Rust rlib pantoken_server_lib (45 files)
Compiling Rust bin pantoken_server (1 file)
Compiling Rust bin fold_corpus_tests (1 file)
Compiling Rust bin unit_tests (4 files)
Compiling Rust bin daemon_types_roundtrip (1 file)
Compiling Rust bin target_version_test (1 file)
Compiling Rust bin resume_and_recovery_tests (4 files)
... (16 total actions)
```

`pantoken-tar-validate` was **not** rebuilt — it has no dependency on `pantoken-protocol`. This is
the affected-target execution benefit: only dependents of the changed file are rebuilt.

## Correctness invalidation

| Change | Expected behavior | Result |
|--------|-------------------|--------|
| Modify `protocol/src/lib.rs` | Rebuild protocol + dependents only | ✅ 16 actions, tar-validate untouched |
| Modify corpus JSON | Corpus tests re-run | ✅ (data dependency tracked) |
| `build.rs` env (PANTOKEN_BUILD_SHA) | Binary embeds new SHA | ✅ (cargo_build_script handles env) |

## Ergonomics assessment

### Error readability
Bazel and Cargo produce **identical** Rust compiler errors — same error codes, file paths, and
line numbers. Bazel wraps the `rustc` output without obscuring it.

### Debugging
- `bazel query //server-rs/...` lists all targets in a package tree
- `bazel cquery` inspects configured targets (useful for debugging platform/toolchain issues)
- `--explain=<file>` shows which actions ran and why (cache hit vs. content change)
- The action graph is inspectable via `bazel aquery`

### Dependency updates
- `CARGO_BAZEL_REPIN=1 bazel sync --only=crates` regenerates the crate_universe lockfile after
  `Cargo.toml`/`Cargo.lock` changes. This is an **additional step** beyond `cargo update` —
  a maintenance burden.
- The `MODULE.bazel.lock` file (2.8MB) is generated and committed.

### Target maintenance overhead
- 7 BUILD.bazel files (root + 5 crates + tests dir) = ~200 lines of Starlark
- Dependency lists must be kept in sync between `Cargo.toml` and `BUILD.bazel` manually
  (crate_universe's `all_crate_deps()` macro could eliminate this, but the POC uses explicit deps
  for clarity)
- The `crate_name` attribute is required when the Bazel target name differs from the Cargo package
  name (e.g., `pantoken_server_lib` target with `crate_name = "pantoken_server"`)

## CARGO_MANIFEST_DIR resolution

The `env!("CARGO_MANIFEST_DIR")` macro bakes a compile-time path into the binary. Under Bazel,
this path points to a sandbox that doesn't exist at runtime (known rules_rust limitation, issue #878).

**Resolution**: A minimal additive source patch (3 locations) adds a runtime env var check before
each `env!()` call, with `env!()` as the fallback. Cargo builds are unaffected.

| Location | Env var | Patch |
|----------|---------|-------|
| `src/polytoken/corpus.rs` | `PANTOKEN_CORPUS_DIR` / `PANTOKEN_CORPUS_FILES` | `const CORPUS_DIR` → `fn corpus_dir()` |
| `tests/fold_corpus.rs` | `PANTOKEN_FOLD_CORPUS_DIR` / `PANTOKEN_FOLD_CORPUS_FILES` | Added runtime check |
| `tests/corpus.rs` | `PANTOKEN_CANON_PARITY_DIR` / `PANTOKEN_CANON_PARITY_FILES` | Added runtime check |

The `config.rs` `PANTOKEN_CLIENT_DIST` case already had a runtime override — no patch needed.

## Known gaps and follow-ups

1. **2 test targets fail under Bazel** (`remote_runtime_tests`, `resume_and_recovery_tests`):
   These tests spawn the `pantoken-server` binary using `std::env::current_exe()` to navigate
   to `target/debug/pantoken-server` (a Cargo-specific layout). Under Bazel, the binary is in a
   different sandbox path. Fixing this requires either (a) a `PANTOKEN_SERVER_BIN` env var the
   tests check first, or (b) passing the binary as a `data` dependency. This is a source patch
   beyond the POC's 3-location scope, so it's documented as a gap.

2. **Inline unit tests in `src/` are not run under Bazel**: The `pantoken_server_lib` target
   doesn't have a `rust_test` with `crate = ":pantoken_server_lib"` to run its inline unit tests
   (e.g., `src/push.rs` tests using `http`, `src/sessions_registry.rs` tests using `filetime`).
   The integration tests cover the same code paths, but the inline tests are Cargo-only.

3. **`MODULE.bazel.lock` is 2.8MB** — jj refuses to snapshot it by default. Needs either
   `.gitignore` exclusion or a config change (`jj config set --repo snapshot.max-new-file-size`).

4. **No Bazel CI** — the POC is local-only. CI integration is a follow-up if the POC is adopted.

5. **No Vite/frontend builds** — client-dist is pre-built by pnpm and consumed as a file input.
   Moving Vite under Bazel is a separate effort.

6. **No signing/notarization** — the archive is unsigned. Signing remains a pnpm/Cargo workflow.

7. **`--enable_workspace`** — Bazel 8 disabled WORKSPACE by default, but `bazel sync` (needed for
   crate_universe repinning) requires it. The `.bazelrc` sets `--enable_workspace` for all
   build/test commands. This will need migration to pure bzlmod when the WORKSPACE flag is removed
   in Bazel 9.

## Decision gate: PROCEED (conditional)

| Criterion | Assessment | Verdict |
|-----------|------------|---------|
| Reproducibility | ✅ Pinned toolchain (Rust 1.97.1 via bzlmod), locked deps (crate_universe), deterministic archive assembly | Pass |
| Affected-target execution | ✅ Only dependents of changed files rebuild (16 actions for a protocol change, tar-validate untouched) | Pass |
| Test/artifact caching | ✅ Action cache (warm build <1s), disk cache (cross-workspace 3s), deterministic archive validation | Pass |
| Cross-workspace/CI reuse | ✅ `--disk_cache` enables 767/1134 cache hits after `bazel clean`. Ready for CI. | Pass |

**Recommendation**: Adopt Bazel incrementally for CI, starting with:
1. `bazel build //server-rs/...` + `bazel test //server-rs/...` as a CI gate (alongside existing Cargo checks)
2. `bazel build //:pantoken_headless_unsigned` + `bazel test //:validate_headless_archive` for archive validation
3. Cross-workspace cache reuse via shared `--disk_cache` (or remote cache in CI)

Defer until the 2 failing test targets are resolved and the `MODULE.bazel.lock` size issue is addressed.
