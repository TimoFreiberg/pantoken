# pilot — Handoff / Design Doc

A personal, single-user remote-control web UI for the [`pi`](https://github.com/earendil-works/pi) coding agent. Lets me drive agent sessions running on the basement Mac Mini from a browser (work machine) or phone, over Tailscale.

The name: you *pilot* pi remotely (pi + lot).

---

## Why this exists

I want two things at once: freedom to run open-weights models (DeepSeek, Kimi, GLM, etc.) and a genuinely good remote-control experience. The first-party options force a choice:

- **Codex mobile** and **Claude Code Remote Control** both route the remote session through a vendor-owned, account-gated relay. The model underneath is whatever the host runs, but you can't ride the relay without their account — and their hosts don't cleanly honor third-party/open-weights providers anyway (Codex desktop's custom-provider support is broken in the GUI; Codex CLI also dropped Chat Completions in favor of the Responses API, so DeepSeek/Kimi/GLM need a translating proxy).

Building my own flips both problems away:

- **I own the relay.** Tailscale/WireGuard already makes the Mac Mini reachable from anywhere without public exposure. That *is* the "secure relay layer" — no vendor account needed.
- **Model choice lives in pi's core.** `pi-ai` is unified multi-provider, so the open-weights goal and the remote-control goal stop fighting each other. The remote layer doesn't know or care which model is behind it.

---

## What pi gives us to build on

These are the facts the whole design depends on. Sources: [`docs/rpc.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [`pi.dev/docs/latest/rpc`](https://pi.dev/docs/latest/rpc), package READMEs.

**Two integration surfaces (both clean — no PTY/terminal-scraping needed):**

1. **In-process SDK** (`@earendil-works/pi-coding-agent`): `createAgentSession(...)` and `session.prompt(...)`; `createAgentSessionRuntime()` / `AgentSessionRuntime` for multi-session runtime. This is the recommended path for Node apps. See `src/core/agent-session.ts`, `docs/sdk.md`.
2. **RPC mode** (`pi --mode rpc`): JSON protocol over stdin/stdout for non-Node integrations. Flags include `--provider <name>`, `--model <provider/id>`, `--no-session`, `--session-dir`. Commands take an optional `id` for request/response correlation. There's also `--mode json` (structured event print mode).

**Framing footgun (RPC):** strict LF-only JSONL. Split on `\n` only. Node's `readline` is *not* compliant — it also splits on U+2028/U+2029, which are valid inside JSON strings. A Rust client using `read_until(b'\n')` is naturally safe here.

**Event/interaction model — this is the keystone for remote control:**

- Streaming output: `message_update` events carry an `assistantMessageEvent` with deltas (`text_delta`); `agent_end` marks turn completion.
- Interaction protocol: `extension_ui_request` / `extension_ui_response`.
  - **Blocking dialog methods** (`select`, `confirm`, `input`, `editor`): emit a request on stdout and **block until** the client sends an `extension_ui_response` with the matching `id`. → These are the approval gates.
  - **Fire-and-forget** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit, no response expected. → These feed status/notifications.
  - A request may include a `timeout`; the agent side auto-resolves with a default when it expires, so a client that drops offline mid-approval won't wedge the agent. The client doesn't track timeouts.
- Reference example: `examples/rpc-extension-ui.ts` (pairs with `examples/extensions/rpc-demo.ts`).

**Security:** pi has no built-in permission system — it runs with the launching user's permissions. Hardening = sandbox/containerize the whole process (OpenShell, the Gondolin micro-VM extension, or plain Docker), *not* sprinkling in granular permissions. pi does show a trust prompt the first time it enters a new repo, which is the one worthwhile gate because an `AGENTS.md` can drive arbitrary agent behavior (instruction-injection surface).

---

## Decisions (settled)

- **Name:** `pilot`.
- **Frontend:** Svelte 5 SPA, served from the box, reached over Tailscale, installable as a **PWA** so it's app-like (window, icon, notifications) on both phone and desktop from one codebase. **Tauri deferred** — a thin remote client gains little from it; revisit only for deep-OS needs (system tray background, native keychain). One UI, accessed via browser or installed interchangeably.
- **Scope:** minimal and purpose-built. *Not* reimplementing the full extension-capable UI. Implement rich UI for the approval gates I actually hit (`confirm` / `select` / `input`); render any unhandled `extension_ui_request` method or custom widget as a **generic fallback card** (raw payload + approve/deny), with the built-in timeout auto-resolve as backstop. Minimal but not brittle — a pi update emitting a new method degrades gracefully instead of breaking.
- **Security posture:** run pi in skip-permissions mode; harden by auto-containerizing, not by adding permissions. Honor the new-repo trust prompt. Decide the isolation approach up front (see open questions).
- **Transport:** Tailscale/WireGuard. No public exposure.
- **Integration approach:** use pi's structured surfaces (RPC mode / SDK), never terminal-scraping.

## Recommended / to confirm

- **Backend:** Rust + Axum on the Mac Mini, spawning `pi --mode rpc` as a child and bridging JSONL ↔ WebSocket. Reuses the KellerComm Axum + Svelte + WS skeleton, and Rust sidesteps the JSONL framing footgun. *Alternative:* a Node/TS server embedding `AgentSessionRuntime` directly (lower friction, best-supported, but TypeScript). Leaning Rust.
- **Diff view:** deferred (see below).
- **Container strategy:** OpenShell vs Gondolin vs Docker — TBD.

---

## Interface — minimal surface

Five elements:

1. **Transcript** — the heart. Streaming assistant text (`text_delta`), plus tool calls and their results inline. Chat-like on phone, wider on desktop. Design it so a diff view can slot in later.
2. **Prompt input + Stop** — text box for prompts/follow-ups, plus a visible interrupt.
3. **Approval cards** — the mobile money-maker. Big tappable Approve/Deny surfaced from the blocking dialog requests. This is what makes "control from my phone" feel real.
4. **Status header** — model/provider, session name, connection state; fed by `setStatus` / `setTitle` / `notify`.
5. **Diff view (deferred)** — show file edits as diffs; what separates a *coding* remote from a generic chat. Defer, but keep the transcript extensible toward it.

**Multi-client semantics** (work browser + phone on the same live session):

- Server is authoritative; clients are pure projections of the event stream.
- On every (re)connect the server pushes a **snapshot** — current transcript + any pending approval — so a freshly opened client catches up without replaying from zero. (Same "server owns it, clients reattach" discipline as KellerComm.)
- Approvals are **first-responder-wins**: whoever taps first resolves the `id`; others see it settle.

**Notifications:** pipe `notify` events to the Web Notifications API (and Web Push if it should fire while the tab is closed). "Agent finished" / "agent waiting on approval" buzzing the phone while I'm upstairs is the moment this justifies itself — and the main payoff of the PWA route over a bare browser tab.

---

## Open questions / next steps

1. **Client↔server message contract.** Define the snapshot-on-connect shape, and which pi events pass through verbatim vs. which the server intercepts/transforms. Pull the full command/event schema from `docs/rpc.md` and the `rpc-extension-ui.ts` example.
2. **Wireframes.** Mobile-first and desktop layouts for the five elements above.
3. **Isolation story.** Pick the container/sandbox approach before wiring real execution to phone taps.
4. **Backend language lock-in.** Confirm Rust + Axum + RPC subprocess vs. Node embed.

---

## Stack & references

- pi monorepo: <https://github.com/earendil-works/pi>
  - `@earendil-works/pi-coding-agent` — agent CLI + SDK (`AgentSession`, `AgentSessionRuntime`)
  - `@earendil-works/pi-agent-core` — agent runtime (tool calling, state)
  - `@earendil-works/pi-ai` — unified multi-provider LLM API
- RPC protocol: <https://pi.dev/docs/latest/rpc>
- Containerization patterns: `packages/coding-agent/docs/containerization.md`
- Prior art to check before building rendering from scratch: pi's own TUI/web UI libraries, and `earendil-works/pi-chat`.
- Transport: existing Tailscale/WireGuard setup on the Mac Mini.
- Frontend lineage: KellerComm (Axum + Svelte 5 + WS) is the structural template.