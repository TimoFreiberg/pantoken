# pantoken

A personal, single-user gui for the [`polytoken`](https://docs.polytoken.dev/introduction/)
coding agent, with remote control and mobile app aspirations.

Tauri app with a Svelte frontend and an internal Rust server.

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

```bash
bun install
PANTOKEN_DRIVER=mock bun run dev   # mock driver
# or if you want to run a real coding agent:  bun run dev
open http://localhost:5173
```

The server defaults to the real agent driver. Set `PANTOKEN_DRIVER=mock` to use the
deterministic mock — you want this for UI development without a running polytoken daemon
and for the dev bar (`http://localhost:5173/?dev`).

`http://localhost:5173/?dev` adds a dev bar to drive the mock to any UI state.
`http://localhost:8787/debug/state` dumps the authoritative session state as JSON.

**Tests:** `bun test` (unit) needs no mock; `bun run test:e2e` (Playwright) sets
`PANTOKEN_DRIVER=mock` automatically.
