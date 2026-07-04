# Pilot Rust Server

Rust port of the pilot server (`server/`). Same WS protocol, HTTP endpoints, and
driver behavior — validated against the existing e2e suite.

## Crate structure

```
server-rs/
├── Cargo.toml                # workspace
├── pilot-protocol/           # WS protocol types + fold reducer (shared logic)
│   └── src/
│       ├── lib.rs
│       ├── wire.rs           # ClientMessage, ServerMessage
│       ├── state.rs          # SessionState, foldEvent, foldAll
│       └── session_driver.rs # SessionDriverEvent, SessionSnapshot
├── pilot-daemon-types/       # Daemon wire types (generated from OpenAPI)
│   └── src/
│       └── lib.rs            # generated via scripts/codegen-polytoken-rs.ts
└── pilot-server/             # The server binary
    └── src/
        ├── main.rs           # entrypoint (axum router)
        ├── config.rs         # env-based config
        ├── hub.rs            # SessionHub (WS fan-out + journal + handleClient)
        ├── journal.rs        # per-session append-only event journal
        ├── fake_daemon.rs    # in-process fake daemon (replaces mock-driver)
        ├── push.rs           # Web Push (VAPID, subscription store)
        ├── pidlock.rs        # PID lock + server identity
        ├── settings_store.rs # pilot-settings.json read/write
        ├── static_serve.rs  # gzip-cached static file serving
        ├── ws_send.rs        # backpressure-aware WS send
        └── polytoken/        # polytoken driver modules
            ├── daemon_client.rs  # HTTP+SSE+process-lifecycle client
            ├── event_map.rs      # daemon→pilot event mapping
            ├── history_seed.rs   # history→seed conversion
            ├── driver.rs         # DaemonDriver (implements PilotDriver)
            ├── ui_bridge.rs      # interrogative response builder
            ├── models.rs         # model registry
            ├── commands.rs       # slash command parsing
            ├── facets.rs        # facet list parsing
            ├── sessions_registry.rs  # session list scanning
            ├── config_notify.rs # notification config
            └── file_catalog.rs   # file index handling
```

## Commands

```bash
cargo build       # build the server
cargo test        # run all tests (143 tests)
cargo run         # run the server (reads PILOT_PORT, PILOT_DATA_DIR, etc.)
```

## Codegen

Daemon wire types are auto-generated from the polytoken binary's OpenAPI spec:

```bash
bun run scripts/codegen-polytoken-rs.ts
```

This runs `polytoken openapi` and generates `pilot-daemon-types/src/lib.rs` with
161 serde types including the 60-variant `DaemonEvent` discriminated union.

## E2E integration

Set `PILOT_SERVER_IMPL=rust` to launch the Rust binary instead of the Bun server:

```bash
PILOT_SERVER_IMPL=rust PILOT_DRIVER=mock bun run dev
PILOT_SERVER_IMPL=rust bun run test:e2e
```

Mock mode (`PILOT_DRIVER=mock`) uses `mock_driver.rs` — a direct Rust port of
the TS MockDriver serving fixture data as `SessionDriverEvent`s, matching the
TS server's architecture. Note: `fake_daemon.rs` (an in-process daemon-protocol
router, the abandoned earlier approach to mock mode) is dead code and slated
for removal along with the hand-added `DaemonEvent::Passthrough` variant in the
generated types — see `PROGRESS.md`.
