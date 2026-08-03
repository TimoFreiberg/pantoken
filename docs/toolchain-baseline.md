# Toolchain Baseline

Reproducible pre-migration baseline for the pantoken build system. Pinned tool
versions, the checks/tests/builds that must remain valid, pnpm's dependency
release-age protection, and representative timings — so future Buck2-migration
failures can be attributed to the migration rather than floating tools or
pre-existing drift.

This baseline was established for [Buck2 migration Ticket 2](https://github.com/TimoFreiberg/pantoken/issues/97). The additive Buck2 rules and verification policy is [`docs/buck2-policy.md`](buck2-policy.md).

## Pinned tool versions

| Tool | Version | Pin mechanism | Location |
|------|---------|---------------|----------|
| pnpm | 11.17.0 | `packageManager` field in `package.json` | `package.json` |
| Node | 22 LTS  | `.nvmrc` (read by nvm/fnm/volta) | `.nvmrc` |
| Rust | 1.97.1  | `rust-toolchain.toml` (channel + components) | `rust-toolchain.toml` |
| Vitest | 4.1.x | devDependency | `package.json` |
| tsx | 4.23.x | devDependency | `package.json` |

### pnpm

pnpm is pinned via the `packageManager` field in `package.json`:

```json
"packageManager": "pnpm@11.17.0"
```

The `pnpm/action-setup@v4` CI action reads this field automatically. Locally,
Corepack (bundled with Node) can also read it — `corepack enable pnpm` makes
the pinned version available without a global install.

Node is pinned via `.nvmrc` (read by `nvm`/`fnm`/`volta`). CI uses
`actions/setup-node@v4` with `node-version-file: .nvmrc`.

**To update pnpm:** change the version in `package.json`'s `packageManager`
field, then run `pnpm install` to regenerate `pnpm-lock.yaml`.

### Single-runtime (Node + tsx)

The project uses a single JavaScript runtime: **Node**, with **tsx** as the
TypeScript script runner. Tests run via **Vitest** (`vitest run`). Scripts run
via `tsx scripts/foo.ts`. The `bun:test` runner is retired; `bunfig.toml` is
removed. Bun-specific runtime APIs (`Bun.spawn`, `Bun.file`, `Bun.sleep`,
`import.meta.main`, `import.meta.dir`) are replaced with Node-standard
equivalents via `scripts/lib/node-compat.ts`.

### Rust

Rust is pinned via `rust-toolchain.toml` at the repo root:

```toml
[toolchain]
channel = "1.97.1"
components = ["rustfmt", "clippy"]
```

rustup auto-reads this file for every `cargo` command, both locally and on
GitHub runners (where rustup is pre-installed). The `rustfmt` and `clippy`
components are listed explicitly because they are required by `cargo fmt
--check` and `cargo clippy` in CI and `just check-rs` locally.

**To update Rust:** change the `channel` in `rust-toolchain.toml` and verify
`just check-rs` passes.

### Pinned version vs MSRV

The pinned Rust version (1.97.1) is distinct from the MSRV declared in
`Cargo.toml`:

- `rust-toolchain.toml` channel `1.97.1` — the version developers and CI use.
- `Cargo.toml` `rust-version = "1.85"` — the minimum supported Rust version
  for building the crates (MSRV). A developer using an older Rust (≥ 1.85)
  can build the code, but CI and the canonical workflow use the pinned 1.97.1.
- `Cargo.toml` `edition = "2024"` requires Rust ≥ 1.85; 1.97.1 satisfies this.

## Observed (not pinned) versions

These prerequisite tools are documented in `README.md` / `AGENTS.md` but are
**not pinned** — the issue scopes pinning to pnpm and Rust only.

| Tool | Version | Notes |
|------|---------|-------|
| just | 1.57.0 | |
| cargo-nextest | 0.9.140 | Test runner for the Tauri desktop crate only |
| direnv | 2.37.1 | Activates `.envrc` (sets `CARGO_TARGET_DIR`) |
| jj | 0.43.0 | Version control system |
| Playwright | 1.61.0 | E2E test framework |

## Checks, tests, and builds that must remain valid

These are the check/test/build/release paths that must remain green after the
Buck2 migration. Any regression in these paths must be attributable to the
migration, not to pre-existing drift.

### Local (`just` recipes)

| Recipe | Description |
|--------|-------------|
| `just check` | Typecheck (protocol, scripts, e2e, parity, svelte) |
| `just test` | Unit tests |
| `just check-rs` | Rust fmt + Buck2 clippy/build/test |
| `just build-client` | Client production bundle |
| `just e2e` | Mock-driver Playwright suite |
| `just e2e-live` | Corpus-backed live-driver suite |
| `just build-headless` | Headless release artifact |
| `just validate-headless-artifact` | Artifact validation |
| `just smoke-test-headless` | Artifact smoke test |
| `just release` | Desktop release (signing) |
| `just publish` | Desktop publish + updater manifest |

### CI jobs (`.github/workflows/ci.yml`)

| Job | Description |
|-----|-------------|
| `web-check` | Typecheck + unit tests |
| `web-e2e` | Playwright e2e (2 shards, mock driver) |
| `web-live` | Blocking corpus-backed live e2e (fake daemon, provider-free) |
| `desktop` | Tauri shell fmt + clippy + nextest (macOS) |
| `rust-server` | Rust server fmt + Buck2 clippy/build/test |
| `release-prepare` | Signed macOS desktop + headless artifacts |
| `release-prepare-linux` | Linux x86_64 headless artifact |
| `release` | Publish (tag-triggered, gated by all above) |

### Release dry-run / smoke paths (from CI)

- `tsx scripts/desktop/publish.ts --dry-run --repo TimoFreiberg/pantoken --tag-must-match <tag>`
- `tsx scripts/headless/build.ts --tag <tag>`
- `tsx scripts/headless/validate-artifact.ts <archive>`
- `tsx scripts/headless/smoke-test.ts <payload-dir>`

## Dependency release-age protection

pnpm's dependency release-age protection is configured in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAge: 4320
```

This enforces a 3-day (4320 minutes) cooldown on npm package resolution —
refusing to resolve any package version published less than 3 days ago. It
covers both direct and transitive dependencies at resolution time. The value
tops the dominant npm-malware detection band (most malicious versions are
yanked within minutes–hours) and matches Renovate's default.

**Caveats:**
- Enforced only when versions are (re)resolved — a version already pinned in
  `pnpm-lock.yaml` is NOT re-checked. This is by design: the cooldown gates
  NEW picks; `pnpm audit` covers already-installed packages.
- A plain `pnpm install` / deploy honors the committed lockfile and is
  unaffected by the cooldown.

## Representative timings

_Captured: 2026-07-27 on macOS 26.5.2 (arm64), Apple M1 Pro._

_These are comparison points, not a performance program. Machine-specific;
re-capture on the same machine for like-for-like comparison._

| Metric | Time |
|--------|------|
| Rust build (warm) | 8.4s |
| Rust build (clean) | 11.4s |
| Rust build (incremental) | 2.5s |
| Client build (warm) | 4.1s |
| Client build (clean) | 1.8s |
| Client build (incremental) | 1.8s |
| Unit tests (pnpm test) | 72.8s |
| Typecheck (pnpm run check) | 6.8s |
| E2E (pnpm run test:e2e) | 596.0s |
| Workspace startup (create + install) | 0.7s |

**Notes:**
- Rust builds use the shared `CARGO_TARGET_DIR` (`$HOME/Library/Caches/pantoken-cargo-target`,
  set via `.envrc`/direnv), so "warm" means the shared cache has the artifacts.
- "Clean" Rust build removes `pantoken-server` artifacts from the shared cache
  via `cargo clean -p pantoken-server`; dependencies remain cached.
- "Incremental" = `touch` one source file (mtime-only change; jj content-hashing
  is unaffected, so the working tree stays clean).
- E2E boots its own dev server + browser suite. 2 of 763 tests failed in this
  capture (flaky timing; not related to toolchain changes).
- 3 `update-headless.sh` integration tests fail outside a proper macOS launchd
  service environment — pre-existing, unrelated to toolchain pinning.
- Workspace startup includes `just create-workspace` (jj workspace creation)
  + `pnpm install --frozen-lockfile` in the new workspace. The pnpm store
  cache makes this near-instant.

To re-capture timings, run `just baseline-timings` from the default jj
workspace (repo root). See `scripts/capture-baseline-timings.sh`.

For Buck2 timing comparisons (cold, warm, incremental, test, archive,
cross-workspace cache reuse), see
[`docs/buck2-poc-findings.md`](buck2-poc-findings.md) § Timing comparison.

## How to reproduce

From a clean checkout:

```bash
# 1. Install prerequisites: Node 22 (via nvm/fnm/volta or direct), pnpm,
#    rust (via rustup), just, Buck2, direnv, jj, and
#    Playwright browsers. cargo-nextest is additionally needed for the
#    macOS-only Tauri desktop gate.
#    rustup reads rust-toolchain.toml automatically — the pinned 1.97.1
#    (with rustfmt + clippy) is installed on first cargo command.
#    nvm/fnm reads .nvmrc automatically — Node 22 LTS is installed.

# 2. Allow direnv (sets CARGO_TARGET_DIR and other env):
direnv allow

# 3. Install frozen dependencies:
pnpm install --frozen-lockfile

# 4. Verify pinned tool versions:
pnpm --version    # → 11.17.0
node --version    # → v22.x.x
rustc --version   # → rustc 1.97.1

# 5. Run the quality gate + Rust gate:
just quality      # check + unit tests
just check-rs     # Rust fmt + clippy + Buck2 build/test
```

Both `just quality` and `just check-rs` must pass with the pinned tools.
