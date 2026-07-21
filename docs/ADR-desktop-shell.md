# ADR — Desktop shell: Tauri now, Bun hub as supervised sidecar, Rust hub behind go/no-go

summary of the current state by the author, as far as i remember:
Tauri is the only frontend right now.
There is one rust backend server impl.
Tauri bundles the entire app.
The app requires Polytoken to be installed locally. 
The app is packaged via GitHub Action, and installed by downloading from GitHub releases. 
The main repo is on GitHub now. 
The server acts as a hub between the GUI frontend and an arbitrary number of polytoken daemons each running one agent session. 
The Tauri front end auto updates the entire app.

## Narrow IPC exceptions for the hub-served web client

By design the hub-served web client gets **no** Tauri IPC (see
`desktop/capabilities/default.json`). Three deliberate, narrow exceptions exist,
both granted to the client's `http://127.0.0.1:<port>` origin via a `remote`
capability:

- **`window-drag`** — `data-tauri-drag-region` on the chromeless header calls
  `plugin:window|start_dragging`. Tauri's injected script handles this with no
  Tauri-specific JS in the client.
- **`dock-attention`** — `request_dock_attention` bounces the macOS dock icon
  when the agent's turn ends or needs input and the window is unfocused. This
  replaces the browser Web Notifications path, which is broken in Tauri's
  WKWebView on macOS (`new Notification()` silently fails). The client calls
  `window.__TAURI_INTERNALS__.invoke` directly — no `@tauri-apps/api` dependency
  — keeping the zero-Tauri-dependency client design intact.
- **`dock-badge`** — `set_dock_badge` sets the macOS dock icon's badge label
  to the count of unread sessions. Called reactively from the web client's
  unread-state effect whenever `store.unread` changes. Clears when all
  sessions are read. Same direct `__TAURI_INTERNALS__.invoke` pattern, no
  `@tauri-apps/api` dependency.
