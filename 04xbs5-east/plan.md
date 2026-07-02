# Plan: MCP server management UI

## Goal

Implement the TODO at `docs/TODO.md:435`: surface MCP server status + enable/disable/reconnect controls in Settings, and un-swallow the 4 lifecycle events (`mcp_server_connected/disconnected/reconnecting/disabled`) as visible notices.

## Implementation Summary

Full-stack feature: add MCP server status to the session snapshot, add daemon-client MCP methods, driver interface methods, wire messages, hub dispatch, store methods, a new Settings "MCP" tab with server list + action buttons, and map the 4 lifecycle events to notify cards.

### Scope decision

The daemon's MCP API supports enable/disable/disconnect/reconnect + OAuth. OAuth start/callback is complex (redirect flow) and deferred — only enable/disable/reconnect/disconnect are wired. The MCP server list is read-only in the snapshot (status + tool_count); actions are fire-and-forget POST calls that trigger lifecycle events.

## Implementation Plan

### Phase 1: Protocol — add McpServerStatus type + snapshot field + wire messages

In `protocol/src/session-driver.ts`:
- Add `McpServerStatus` type ("connected" | "disconnected" | "reconnecting" | "disabled")
- Add `McpServerInfo` interface: `{ serverName: string; status: McpServerStatus; toolCount: number }`
- Add `mcpServers?: readonly McpServerInfo[]` to `SessionSnapshot`

In `protocol/src/wire.ts`:
- Add `setMcpServer` client message: `{ type: "setMcpServer"; serverName: string; action: "enable" | "disable" | "disconnect" | "reconnect"; sessionId?: SessionId }`

### Phase 2: Driver interface + implementations

In `server/src/driver.ts`:
- Add optional `setMcpServer?(serverName: string, action: "enable" | "disable" | "disconnect" | "reconnect", sessionId?: SessionId): Promise<void>`

In `server/src/polytoken/daemon-client.ts`:
- Add methods: `enableMcpServer(name)`, `disableMcpServer(name)`, `disconnectMcpServer(name)`, `reconnectMcpServer(name)` — each `POST /mcp/{name}/{action}`

In `server/src/polytoken/polytoken-driver.ts`:
- Implement `setMcpServer` — calls the appropriate daemon-client method, then fetchState + emit sessionUpdated (so the snapshot carries the new status)

In `server/src/mock-driver.ts`:
- Implement `setMcpServer` — update a local `mcpServers` array, emit sessionUpdated with the new status

### Phase 3: Event-map — thread mcp_servers into snapshot + un-swallow events

In `server/src/polytoken/event-map.ts`:
- In `snapshotFromState`, add `mcpServers: state?.mcp_servers?.map(...)` (project to `McpServerInfo[]`)
- Pull the 4 `mcp_server_*` cases out of the `return EMPTY` group and map each to a `hostUiRequest{kind:"notify"}` notice:
  - `mcp_server_connected` → info: "MCP server {name} connected"
  - `mcp_server_disconnected` → warning: "MCP server {name} disconnected ({reason})"
  - `mcp_server_reconnecting` → info: "MCP server {name} reconnecting (attempt {attempt})..."
  - `mcp_server_disabled` → warning: "MCP server {name} disabled ({reason})"

### Phase 4: Hub dispatch

In `server/src/hub.ts`:
- Add `case "setMcpServer"` — fire-and-forget `void this.driver.setMcpServer(...).catch(...)` matching `toggleAdventurousHandoff`

### Phase 5: Store method

In `client/src/lib/store.svelte.ts`:
- Add `setMcpServer(serverName, action)` that sends the wire message

### Phase 6: Settings UI — new "MCP" tab

In `client/src/components/Settings.svelte`:
- Add `"mcp"` to `SectionId` and `SECTIONS`
- Add an MCP section showing:
  - A list of `store.session.mcpServers` (if any), each with:
    - Server name + status badge (colored dot)
    - Tool count
    - Action buttons: Enable (if disabled), Disable (if enabled), Reconnect (if disconnected/reconnecting), Disconnect (if connected)
  - Empty state: "No MCP servers configured. Configure them in the daemon's config."
  - Hotkey: Alt+6 to jump to the MCP tab

### Phase 7: E2E test

In a new or existing e2e test, add a test that:
- Opens Settings, navigates to the MCP tab
- Verifies the server list renders (mock should have at least one MCP server)
- Tests the reconnect button (fire-and-forget, no visible change in mock)

### Phase 8: Update docs/TODO.md

Mark line 435 as `[x]` with a Done note.

## Acceptance Criteria

**AC.1** — `McpServerInfo` type + `mcpServers` field exist in the protocol snapshot. Verified by: `grep "mcpServers\|McpServerInfo" protocol/src/session-driver.ts` returns matches.

**AC.2** — `setMcpServer` wire message exists. Verified by: `grep "setMcpServer" protocol/src/wire.ts` returns a match.

**AC.3** — Driver interface has `setMcpServer?` and both drivers implement it. Verified by: `grep "setMcpServer" server/src/driver.ts server/src/polytoken/polytoken-driver.ts server/src/mock-driver.ts` returns matches.

**AC.4** — The 4 `mcp_server_*` events are mapped to notify notices (not `return EMPTY`). Verified by: `grep "mcp_server_connected\|mcp_server_disconnected\|mcp_server_reconnecting\|mcp_server_disabled" server/src/polytoken/event-map.ts` — each appears in its own case, not in the `return EMPTY` group.

**AC.5** — Hub dispatches `setMcpServer`. Verified by: `grep "setMcpServer" server/src/hub.ts` returns a match.

**AC.6** — Settings has an "MCP" tab showing server status + action buttons. Verified by: e2e test.

**AC.7** — `bun run check` exits 0. `bun test` exits 0. `bun run test:e2e` exits 0 (no new failures).

## Risks

**Risk: mock driver needs MCP server fixtures.** The mock's `snapshot()` function needs to include `mcpServers` in the snapshot. Add a static fixture with 1-2 servers (one connected, one disconnected).

**Risk: mcp_servers_changed flag.** The daemon state has `mcp_servers_changed?: boolean` — this might be a delta flag indicating the list changed since last fetch. Need to check if `fetchState` on the event-map handles this. If `mcp_servers_changed` is true, the `fetchState` effect will re-snapshot with the new list. This should work automatically.

**Risk: OAuth flows deferred.** The daemon has OAuth start/callback endpoints for MCP servers that require auth. These are deferred — only enable/disable/reconnect/disconnect are wired. Document this in the TODO note.

## Review Strategy

Plan-mode review: dispatch `plan-reviewer` subagent.

Implementation review: dispatch `general-purpose` subagent after execution.
