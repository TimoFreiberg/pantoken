# Pantoken Rust Server

The pantoken server, in Rust. Same WS protocol, HTTP endpoints, and driver behavior.
Axum-based WS bridge + HTTP routes + static file serving.

## Crate structure

```
server-rs/
├── Cargo.toml                # workspace
├── pantoken-protocol/           # WS protocol types + fold reducer (shared logic)
│   └── src/
│       ├── lib.rs
│       ├── wire.rs           # ClientMessage, ServerMessage
│       ├── state.rs          # SessionState, foldEvent, foldAll
│       └── session_driver.rs # SessionDriverEvent, SessionSnapshot
├── pantoken-daemon-types/       # Daemon wire types (generated from OpenAPI)
│   └── src/
│       └── lib.rs            # generated via scripts/codegen-polytoken-rs.ts
├── pantoken-remote-layout/      # Remote provisioning path-safety
│   └── src/
│       └── lib.rs
├── pantoken-tar-validate/       # Archive path-safety for provisioning
│   └── src/
│       └── main.rs
├── pantoken-server/             # The server binary
│   └── src/
│       ├── main.rs           # entrypoint (axum router)
│       ├── config.rs         # env-based config
│       ├── hub.rs            # SessionHub (WS fan-out + journal + handleClient)
│       ├── journal.rs        # per-session append-only event journal
│       ├── push.rs           # Web Push (VAPID, subscription store)
│       ├── pidlock.rs        # PID lock + server identity
│       ├── settings_store.rs # pantoken-settings.json read/write
│       ├── static_serve.rs   # gzip-cached static file serving
│       ├── ws_send.rs        # backpressure-aware WS send
│       └── polytoken/        # polytoken driver modules
│           ├── daemon_client.rs  # HTTP+SSE+process-lifecycle client
│           ├── event_map.rs      # daemon→pantoken event mapping
│           ├── history_seed.rs   # history→seed conversion
│           ├── driver.rs         # DaemonDriver (implements PantokenDriver)
│           ├── ui_bridge.rs      # interrogative response builder
│           ├── models.rs         # model registry
│           ├── commands.rs       # slash command parsing
│           ├── facets.rs        # facet list parsing
│           ├── sessions_registry.rs  # session list scanning
│           ├── config_notify.rs # notification config
│           └── file_catalog.rs   # file index handling
└── ts-test-reference/        # Archived TS tests (see its README.md)
```

## Commands

```bash
cargo build       # build the server
cargo test        # run all tests
cargo run         # run the server (reads PANTOKEN_PORT, PANTOKEN_DATA_DIR, etc.)
```

CI enforces `cargo fmt --check` + `cargo clippy --locked --all-targets -- -D
warnings` + `cargo test` (the `rust-server` job in `.github/workflows/ci.yml`);
run `pnpm run check:rs` from the repo root for the same locally.

## Codegen

Daemon wire types are auto-generated from the polytoken binary's OpenAPI spec:

```bash
just codegen-polytoken-rs
```

This runs `polytoken openapi` and generates `pantoken-daemon-types/src/lib.rs` from the
installed daemon version. The current pinned baseline is `polytoken 0.5.8`: the
OpenAPI document contains 178 component schemas and the generated Rust contains 178
matching declarations, including the 57-variant `DaemonEvent` discriminated union.
The checked-in fixture at `pantoken-daemon-types/tests/fixtures/polytoken-0.5.8-openapi.json`
and its inventory test make this source-of-truth comparison deterministic.

## E2E integration

The Rust server is the only server — `pnpm run dev` and `pnpm run test:e2e` spawn
it directly via `cargo run` in `server-rs/`. No env var needed.

Mock mode (`PANTOKEN_DRIVER=mock`) uses `mock_driver.rs` — a deterministic fixture
driver serving `SessionDriverEvent`s, used for dev and the e2e suite.

A third mode, `PANTOKEN_DRIVER=fake`, runs the real `PolytokenDriver` over an
in-process, corpus-backed fake daemon: deterministic like the mock, but it
exercises the live driver stack end-to-end. Run it with `pnpm run test:e2e:live`.

## TS test reference

`ts-test-reference/` contains the TypeScript server's test files, preserved as
reference for porting cases to Rust. See its `README.md` for the file→domain map.
