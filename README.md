# pantoken

A personal, single-user GUI for the [`polytoken`](https://docs.polytoken.dev/introduction/)
coding agent, with remote control and mobile app aspirations.

Tauri app with a Svelte frontend and an internal Rust server.

## Architecture (high level)

Pantoken is a macOS desktop app (`.app`, built with Tauri). It bundles an
internal Rust hub (`pantoken-server`) that serves a Svelte 5 client to a
local browser window and drives the [`polytoken`](https://docs.polytoken.dev)
coding agent daemon.

For remote development, the desktop app SSHes into a remote Mac or Linux
machine, provisions a `pantoken-server` binary there (from a signed release
archive), and bridges the local browser to the remote runtime over a framed
stdio transport. There is no standalone server deployment — the remote
binary is always provisioned and managed by the desktop app.

The release matrix is two targets:
- `aarch64-apple-darwin` — macOS arm64 (local hub + remote Mac provisioning)
- `x86_64-unknown-linux-gnu` — Linux x86_64 (remote provisioning / Docker)

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture and
[`docs/DECISIONS.md`](docs/DECISIONS.md) for settled design decisions.

## Status

Early, close to dogfoodable.

## Install (macOS desktop app)

The app is ad-hoc signed, not notarized — a browser download gets quarantined
and Gatekeeper refuses it. This one-liner fetches it via curl (no quarantine
xattr) and extracts it to `/Applications`:

```bash
curl -fsSL https://raw.githubusercontent.com/TimoFreiberg/pantoken/main/install.sh | bash
```

After the first launch, the app self-updates. Already downloaded a "damaged"
browser copy? Un-quarantine it: `xattr -cr /path/to/Pantoken.app`. See
[`desktop/README.md`](desktop/README.md) for build-from-source and details.

## Quick start (dev)

Before starting, have pnpm, Node, Rust, `just`, `cargo-nextest`, and the Playwright
browsers available. pnpm, Node, and Rust versions are pinned (`package.json` `packageManager`
and `rust-toolchain.toml` respectively); see
[`docs/toolchain-baseline.md`](docs/toolchain-baseline.md) for the full baseline and [`docs/buck2-policy.md`](docs/buck2-policy.md) for the additive Buck2 foundation.
These tools and browsers are prerequisites; recipes do not install or
upgrade them. Invoke the explicit frozen dependency install when needed:

```bash
just install
PANTOKEN_DRIVER=mock just dev
open http://localhost:5173
```

`just install` only runs `pnpm install --frozen-lockfile`. The server defaults to the
polytoken daemon driver; use `PANTOKEN_DRIVER=mock` for UI development without a daemon
and for the dev bar (`http://localhost:5173/?dev`). `just dev <script-args>` passes
additional arguments through to the existing development script.

`http://localhost:5173/?dev` adds a dev bar to drive the mock to any UI state.
`http://localhost:8787/debug/state` dumps the authoritative session state as JSON.

## Common commands

The normal local interface is `just`; descriptions are grouped in `just --list`:

```bash
just quality       # quick check + unit-test gate
just check         # aggregate TypeScript/client checks
just test          # unit tests
just check-rs      # Rust fmt, clippy, and nextest
just build-client  # client production bundle
just e2e           # default mock-driver Playwright suite
just e2e-live      # corpus-backed live-driver suite (expensive)
just build-headless
just validate-headless-artifact
just smoke-test-headless
just release       # signing/release workflow
just publish       # publishing workflow
```

Direct `pnpm`, `pnpm exec`, `cargo`, and Playwright commands remain supported for targeted
debugging, individual typechecks, Rust package selection, CI-specific setup, browser
installation, and other platform-specific workflows. For example, use `pnpm exec tsc ...`
for one typecheck, `pnpm exec playwright test --project=desktop` for a focused E2E run, or
`cd server && cargo run` to run the Rust server directly. The recipes do not
implicitly install dependencies, browsers, or other prerequisites.
