# Pilot — Open questions for you (morning of 2026-06-17)

Ordered by leverage. Each has my recommended default (what I built toward or will
build toward). Veto any and I'll adjust — most are cheap to change because the
frontend, protocol, and verification harness are all backend-agnostic.

## OQ1 — Backend language: TS-embed (what I built) vs Rust-spawn-RPC ⚠️ highest stakes
The handoff leaned Rust (KellerComm reuse). I went **TS-embed** (see D2) because
type reuse + the existing pi-sdk-driver + no framing footgun + in-process tool
labels for extension visibility outweigh it, and KellerComm's *patterns* port
without its language. **If you'd rather have Rust**: we lose only the server
skeleton (~a few hundred lines). The Svelte client, the protocol types, the
mock-fixture concept, and the screenshot harness all carry over. My honest take:
TS is the better fit *specifically because* you want extensions visible and want
to dogfood fast — but it's your call and I want it confirmed before M5 (real SDK
wiring) compounds the investment.

## OQ2 — Concurrency: one in-process session, or process-per-session?
**Default: start single in-process `AgentSession`; design the WS schema (done) to
mirror RPC events so heavy/untrusted sessions can move to a `pi --mode rpc`
subprocess later without redesign.** You're one user; true parallel multi-session
streaming is unlikely day-one. Process-per-session buys crash isolation + resource
limits when you hit the wall.

## OQ3 — Approval posture: how hard do we gate tools?
**Default: ship pilot's own approval extension that gates bash + destructive ops
via confirm/select, on by default.** pi has **no native tool-approval gate** — out
of the box it auto-runs everything including bash. Remote = bigger blast radius;
the phone tap is your last line of defense. Decide granularity: per-tool /
per-command-pattern / remember-this-choice.

## OQ4 — Sandbox by default, and how complete?
**Default: host-side `@anthropic-ai/sandbox-runtime` extended to route
read/write/edit (not just bash — the shipped example only wraps bash, so as-is
it's a false sense of safety), with a strict `sandbox.json`; Gondolin micro-VM as
an opt-in per-session "high isolation" toggle.** Need to confirm macOS
`sandbox-exec` network allowlisting actually holds on your macOS version before
relying on it for egress.

## OQ5 — Notification reach: tab-open only, or backgrounded phone?
**Default: Notification API (tab-open) in MVP; defer Web Push to LATER.** Web Push
for a closed phone is greenfield (service-worker handler + VAPID + subscription
store) and iOS Web Push only works for an *installed* PWA and is historically
flaky. This is the biggest-payoff feature with zero scaffolding — worth validating
on your actual iPhone iOS version before committing.

## OQ6 — Workspace provisioning: how do phone-triggered sessions pick a directory?
**Default: a fixed allowlist of repo paths on the Mac Mini the UI may open; no
arbitrary-path opening from the phone.** The desktop app used a native folder
picker the browser can't; arbitrary remote `cwd` also widens the attack surface.

## OQ7 — Transcript persistence across a *server* restart mid-turn?
**Default: in-memory authoritative transcript for active sessions, backed by pi's
on-disk `.jsonl` for idle/restart recovery; no separate durable store at MVP.**
Surviving a server crash *mid-turn* needs server-side persistence — extra scope.

## OQ8 — Styling fidelity: how close to the Claude app, and dark/light?
**Default: Claude-app-like (warm neutrals, generous spacing, the streaming/tool
card vocabulary), dark-first with a light theme, no permission UI except the
first-run trust card.** Tell me if you want pixel-faithful vs just "same family."
