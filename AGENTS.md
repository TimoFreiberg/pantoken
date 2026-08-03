# AGENTS.md — working in the pantoken repo

Pantoken is a personal, single-user remote-control GUI for the polytoken coding agent.
The codebase is Rust and Svelte, built with buck2.
All build commands go through `just`, see `justfile`.

The agent is a separate codebase, maintained by a separate author, we only build a GUI for an existing product here.
Pantoken is (/ aims to be) a desktop GUI and a mobile app.
The UI/UX mirror the Claude app or Codex desktop, but with focused features.
See `docs/DESIGN.md` for architecture, `docs/DECISIONS.md` for settled calls, `docs/TODO.md` for the backlog.


## Stack & layout

Monorepo, pnpm workspaces.
- `protocol/` — shared, JSON-serializable WS contract + the `foldEvent` reducer that
  runs identically on server & client.
- `server/` — the Rust server. Axum-based WS bridge + HTTP routes + static file
  serving. Six workspace members: `pantoken-protocol` (WS types + fold),
  `pantoken-daemon-types` (auto-generated from OpenAPI), `pantoken-remote-layout`
  (remote provisioning path-safety), `pantoken-server` (the binary),
  `pantoken-tar-validate` (archive path-safety for provisioning), plus `desktop`
  (Tauri desktop app) at the workspace root. The `PantokenDriver` seam has two
  implementors: `mock` (deterministic, for dev/e2e) and `polytoken` (the live
  daemon). **The installed daemon is `0.5.8`** (bearer-token auth). See
  `server/PROGRESS.md` for the live-path validation status before building on
  it. Archived TS tests are in `server/ts-test-reference/` for reference when
  porting cases to Rust.
- `client/` — Svelte 5 + Vite PWA. Reconnecting WS singleton, the same fold reducer,
  Claude-app theming in `src/app.css` (warm paper, light + dark).

Tool versions (pnpm, Node, Rust) are pinned; see
[`docs/toolchain-baseline.md`](docs/toolchain-baseline.md) for the full baseline.

## Commands

The normal contributor interface is `just`. Prerequisites are Node, pnpm, Rust, `just`, Buck2, and Playwright
browsers; recipes do not install or upgrade
these tools. Run the explicit dependency install when needed, then use the mock driver
for local UI work:

```bash
just install
PANTOKEN_DRIVER=mock just dev
just quality                 # check + unit tests, no Rust/E2E/live work
just check                   # aggregate TypeScript/client checks
just test                    # unit tests
just check-rs                # Rust fmt, clippy (buck2), and buck2 build+test
just build-client            # client production bundle
just e2e                    # default mock-driver Playwright suite
just e2e-live               # corpus-backed live-driver suite
just build-headless         # remote server artifact
just validate-headless-artifact
just smoke-test-headless
just release                 # signing/release workflow
just publish                 # publishing workflow
```

**Workspace creation:** always use `just create-workspace <name>` to create jj
workspaces in this repo. It validates names, checks collisions, and ensures the
workspace is created under `.workspaces/` from the default workspace. Never use
`jj workspace add` directly.

## Conventions

- Run an autoformatter before committing.
- VCS is **jj** (see the `jj` skill). Commit when done; review with `jj diff --git`;
  imperative subject ≤72 chars.
- Keep `protocol/` free of runtime/DOM deps — it's imported by both halves
  (the Rust server and the Svelte client).
- The `PantokenDriver` trait is the contract for swapping mock ↔ polytoken. Add
  capabilities there, implement in both drivers.
- **UI conventions & patterns:** when touching `client/`, read
  [`docs/ui-conventions.md`](docs/ui-conventions.md) — it covers shared
  primitives (Chevron, transitions, hotkey/tooltip, touch targets) that every UI
  change must follow. **Quality invariants** (product rules the diff must
  respect) are in [`QUALITY.md`](QUALITY.md); the `quality-review` skill checks
  the applicable subset on review.
