# Pilot — Decisions knocked down (2026-06-16, overnight session)

These are the calls I made autonomously so the build could proceed. Each is
**reversible** unless noted, and the one genuinely contentious one (backend
language) is flagged at the top of `OPEN-QUESTIONS.md` for your veto.

## D1. Repo scope: GUI + remote infra in **one monorepo**
Matches your "lean both." The server *is* the protocol contract — the WS schema,
the server-side transcript folding, and the client reducer that consumes them
must evolve together. Splitting them now forces a published protocol package and
version coordination before the protocol is stable. `pods` (model-serving infra)
is explicitly **out** — it's datacenter-GPU/vLLM/SSH, zero Apple-Silicon fit;
pointing pi at an open-weights endpoint later is a config concern, not this repo.

Layout: `protocol/` (shared types + fold reducer) · `server/` (Bun, embeds pi
SDK, WS, state) · `client/` (Svelte 5 PWA) · `mock/` (deterministic pi fixture,
lives in server for now) · `deploy/` · `docs/`.

## D2. Backend: **TypeScript embedding the pi SDK** (runtime: Bun) — CONTENTIOUS, see OQ1
Not Rust-spawn-RPC. Deciding factors:
- **Type reuse**: import pi's `AgentEvent`/`AgentMessage`/`Model` verbatim instead
  of re-declaring 30 commands + the full event union in Rust and tracking drift.
- **Existing driver**: pi-gui's `pi-sdk-driver` is Electron-free and was designed
  as the exact seam we'd swap into — runs in a Node/Bun server today.
- **No JSONL framing footgun**: embedding means no stdout pipe to frame (the
  LF-only / U+2028 trap that bites a hand-written Rust splitter).
- **Extension visibility** (you care about this): in-process `getAllTools()` gives
  tool labels + descriptions that the RPC wire never serializes.
- KellerComm's value was its *patterns* (reconnect, snapshot, first-responder-wins,
  PWA, Tailscale deploy), not Rust. Those port to a Bun server unchanged.
- Door stays open: the WS schema mirrors the RPC event shape, so heavy/untrusted
  sessions can later be pushed to a `pi --mode rpc` subprocess for crash isolation
  without a redesign.

Runtime = **Bun** (native `Bun.serve` WS, built-in test runner, your ecosystem
fit). Risk: pi SDK under Bun is unproven here — validated at M1; trivial fallback
to Node+tsx since it's all TS.

## D3. Frontend: **fresh Svelte 5 + Vite + Tailwind v4**
Not forking pi-gui's React (Electron/IPC-coupled, single-window/single-session —
the exact multi-client model we must discard). Not pi's `web-ui` (Lit, runs the
agent in-browser — opposite of server-authoritative). We *study* both as a
feature/layout spec. KellerComm's Svelte WS singleton + reducer + PWA bundle are
the highest-ROI steal and are already Svelte 5.

## D4. Protocol: **vendor pi-gui's `session-driver` types** as the WS contract
`SessionDriverEvent` (12 variants) and `HostUiRequest`/`HostUiResponse` are a
clean, JSON-serializable, already-normalized surface — almost 1:1 with what we
need. We wrap them in a small `ClientMessage`/`ServerMessage` envelope with
snapshot-on-connect. Vendored (copied) because the package is `private:0.0.0`.

## D5. State model: server-authoritative, split durable vs per-client view state
**Durable shared** (server-owned, broadcast): sessions, transcripts, statuses,
pending approvals. **Per-client view** (client-local, never shared): selected
session, composer draft, sidebar collapse. Doing this at the protocol level is
load-bearing — broadcasting one whole-state blob (pi-gui's model) makes two tabs
fight over the composer. Three things the server must own because pi can't replay
them: pending approvals, the transcript snapshot, ambient `setStatus`/`setWidget`.

## D6. Verification = deterministic mock-pi fixture + Claude_Preview screenshot loop
The "agent-legible introspection infrastructure" you asked for first. A mock
driver replays scripted `SessionDriverEvent` sequences so every UI state is
reproducible without a live model or API keys — same script → same pixels →
diffable screenshots. Plus a `/debug/state` HTTP endpoint and structured event
log so an agent can assert on server state directly. This is M0 and gates
everything else.
