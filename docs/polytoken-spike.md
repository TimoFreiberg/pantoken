# polytoken spike — confirmed wire shapes (Chunk 0)

> The de-risk gate for `docs/PLAN-polytoken-driver.md`. Every **[VERIFY]** in that
> plan is resolved below, **against a running daemon** (`polytoken 0.3.3`, daemon
> API `0.1.0`) on this mini, not from reverse-engineered contracts.
>
> **Method.** Two self-describing contracts are emitted by the binary itself and
> are the authoritative source — they are not guesses:
>
> ```bash
> polytoken openapi        # → 40-path OpenAPI 3.1 (269 KB)     # the HTTP surface
> polytoken event-schema   # → DaemonEvent JSON Schema (87 KB)  # the SSE stream
> ```
>
> On top of those, a live daemon was spawned with `polytoken new --no-attach`, a
> lease was claimed/heartbeated/released, a prompt was posted, and the `/events`
> SSE was captured end-to-end. Every shape below is either quoted from a schema or
> observed on the wire (marked **observed**).
>
> This supersedes the plan's reverse-engineered assumptions wherever they differ.
> Findings that *correct* the plan are flagged **⚠ CORRECTION**.

## 0. Environment

| | |
|---|---|
| binary | `polytoken 0.3.3` at `/Users/timo/.local/bin/polytoken` (Homebrew) |
| daemon API | `0.1.0` (`GET /version` → `{"version":"0.3.3"}`) |
| config | `~/.config/polytoken/config.yaml` — 2 models, 2 providers; **default model `umans/umans-glm-5.2` is live despite `polytoken doctor` reporting a config mismatch** (a prompt ran successfully, see §4). `polytoken doctor` exits non-zero on the mismatch; treat it as advisory, not a blocker. |
| auth | none on the daemon. `--listen` defaults `127.0.0.1:0` (loopback, OS-assigned port). There is **no auth flag** — confirmed single-user/localhost. |

## 1. Process model — one daemon = one session = one port ✅

Confirmed. `polytoken new --no-attach` (**observed**):

```
session_id=04msc4-zesty port=51269
```

`GET /health` → `HealthResponse`, which echoes a single session record (`session_id`,
`pid`, `port`, `project_path`, `parent_session_id`, `started_at`, `last_heartbeat_at`
— plus optional `session_title`, `process_start_token`). One session, confirming
process-per-session. Endpoints are flat (`/prompt`, `/events`, `/state` — no
`/session/{id}/…`). `--session-id` is singular. So a `PolytokenDriver` keeps a `Map<SessionId, { port, lease, sse, heartbeat }>`
exactly as the plan sketches — one child daemon per warm session. `polytoken daemon
--resume --session-id <id>` is the resume path; `polytoken new --no-attach` is the
cleanest headless-spawn entry point (returns `{session_id, port}` on stdout without
attaching a TUI).

## 2. The attachment lease — pilot is the exclusive attacher ✅

The plan worried whether the lease allows a *concurrent* second client. **Confirmed
exclusive (serial).** `POST /tui-attachment/claim` returns a lease; a second claim
while one is live returns **409 `Another live interactive TUI owns the lease`**.

**`TuiAttachClaimRequest`:**
```jsonc
{ "pid": int32,                    // required — caller's OS pid
  "process_start_token": int64?,   // optional — guards against stale PID reuse
  "terminal_label": string? }      // optional — human label ("pilot")
```

**Claim response (observed):**
```jsonc
{ "lease_id": "019f0dc0-f48b-7f01-b3d3-67d0af08f851",  // UUID
  "heartbeat_interval_seconds": 5,
  "expires_after_seconds": 30,
  "expires_at": "2026-06-28T10:23:27.163019Z" }
```

**Heartbeat:** `POST /tui-attachment/heartbeat` with `{lease_id, pid, process_start_token?}`.
Returns 200 on the owning pid; **409** if the pid doesn't match — so the lease is
*pid-bound*, not token-bound. Pilot must own the lifecycle (the harness lesson holds):
clear the heartbeat timer on session close and on driver shutdown, and release with
`DELETE /tui-attachment/{lease_id}` (→ 204, idempotent).

> The local TUI detaches while pilot drives; re-attach is serial. Treat pilot as the
> exclusive attacher. A concurrent read-only second client is **not** supported by the
> lease; if wanted later it would need a different mechanism (e.g. a second `/events`
> subscriber, which the SSE cap may or may not permit — see §6).

## 3. Prompt + steering — `deliverAs` is pilot-side; images need a path ⚠ CORRECTION

The plan assumed `POST /prompt` carries `deliverAs: steer|followUp` and images. **It
does not.**

**`PromptRequest` (the entire body):**
```jsonc
{ "content": string,                // required — the single text field
  "max_tool_turns": int32? }        // optional — per-request agent-loop cap; null = config default
```

No `deliverAs`, no image field, no structured content blocks. So:

- **`prompt(text)` → `POST /prompt {content}`** (the happy path). Returns **202** with
  `{prompt_id, session_id, resolved_references?}` (`resolved_references` carries
  `@file`-mention resolution when present). **409** if a turn is already in flight (the queue does
  *not* auto-absorb a concurrent prompt — it's rejected). **422** if a pre-user-prompt
  hook denied it.
- **Steering / follow-up (mid-turn) → `POST /turn/input`.** **`PendingTurnInputRequest`
  is also just `{content: string}`** — no discriminator either. The steer/follow-up
  distinction is **pilot's UX label only**; both go to the same queue. The daemon emits
  `pending_turn_input_queued` / `_dequeued` / `_drained` / `_discarded` so pilot can
  reflect queue state, but the daemon does not distinguish steer from follow-up.
- **`clearQueue()` → `DELETE /turn/input/newest` (×n)** (each call dequeues the newest;
  loop until `GET /turn/input` → `{queue_revision, items:[]}`). There is **no atomic
  clear-all** — the plan's "[VERIFY] atomic-clear semantics" is resolved: it's
  one-at-a-time newest-pop. `GET /turn/input` (observed idle: `{"queue_revision":0,"items":[]}`)
  is the snapshot.
- **Images: not in `/prompt`.** `PromptRequest.content` is a string. Image routing is
  not exposed on the documented HTTP surface for a prompt body (no multipart, no content
  blocks). This is an open gap for Chunk 1+ — likely a daemon feature to confirm, or a
  pilot limitation under this driver. **[OPEN]** until a path is found.

**`abort()` → `POST /turn/cancel`** (no body). Returns **202** with
`{prompt_id, status:"cancel_requested"}`. The OpenAPI spec documents a **409** when no
turn is in flight, but **the live daemon was observed returning 202 with
`prompt_id:null`** in that case instead — so the driver must treat **both** 409 and
202-with-null-`prompt_id` as "no active turn / no-op". The canonical idle-emission is the
`turn_cancelled` event (`{prompt_id, reason: CancellationReason}`), which the event-fold
maps to `sessionUpdated(idle)`.

## 4. The event-fold pipeline — empirically confirmed ✅

A live prompt (`"Reply with exactly: hello world"` against the `umans` model, on a
fresh daemon `04msjp-geek`) produced this **observed** SSE trace, which is the exact
accumulator the plan described:

```
notification_autodrain_switch {enabled:true}     # emitted once on first turn
message_start        {prompt_id}                 # turn begins
content_block_start  {prompt_id, block_index:0, block_type:{type:"text"}}
content_block_delta  {prompt_id, block_index:0, delta:{type:"text", text:"hello world"}}
content_block_stop   {prompt_id, block_index:0}
message_complete     {prompt_id}                 # turn ends
```

**The `Envelope<DaemonEvent>` frame shape (observed, authoritative):**
```
id: <seq>
data: { "seq": <int>,
         "emitted_at": "<RFC3339>",
         "session_id": "<id>",
         "event": { "type": "<variant>", …payload } }
```

The `type` discriminator lives at **`event.type`** (not the envelope root) — confirmed.
`seq` is monotonic from 0. `id:` is the SSE event id (matches `seq`); useful for
`Last-Event-ID` resume. **Every event variant also carries an optional
`subagent_handle: string|null`** (omitted from the shape quotes below for brevity) —
when non-null, the frame belongs to a nested subagent turn, and the event-fold must
tag/route it for a future subagent view rather than treat it as top-level transcript.

**`BlockDeltaPayload` (the delta union — confirms the accumulator design):**
```jsonc
{ "type": "text",            "text": string }                 // → assistantDelta (main channel)
| { "type": "thinking",      "text": string }                 // → assistantDelta (thinking channel)
| { "type": "tool_use_input","partial_json": string }         // → accrue into the tool_use block
| { "type": "signature_delta", "signature": string }          // Anthropic thinking-block sig (pass through)
```

**`ContentBlockKind` (set on `content_block_start`):** five variants — `text |
tool_use{id,name,provider_metadata?} | thinking | redacted_thinking |
open_ai_reasoning_opaque`. The last three are unit variants (`{"type":"…"}` only, no
payload). (`open_ai_reasoning_opaque` is the OpenAI/Codex analog of Anthropic's
`redacted_thinking`.)

**Tool plumbing (the ordering the plan [VERIFY]'d):**
- `content_block_start` with `block_type:{type:"tool_use", id, name}` → accumulator opens a tool block.
- `content_block_delta` with `delta.type:"tool_use_input"` → accumulate `partial_json` (don't emit yet).
- **`tool_call`** event (`{prompt_id, call_id, name, input?}`) is the authoritative
  tool-start signal — `input` is the *complete* parsed input. Emit pilot's `toolStarted` here.
- **`tool_result`** event (`{prompt_id, call_id, content?:string, content_full?:ToolLiveDisplayContent, is_error?:bool}`)
  → `toolFinished`. `content` is truncated/short-form; `content_full` carries the rich
  display content (lift images from it like `splitToolResult`).
- `content_block_stop` closes the accumulator window (no separate emit needed if `tool_call` fired).

So the plan's "[VERIFY] which fires first / authoritatively" is resolved: **`tool_call`
is authoritative**; `content_block_stop` is just the stream boundary. The accumulator
should emit `toolStarted` on `tool_call` (not on `content_block_stop`).

**`message_complete` → `runCompleted`** — the turn boundary, exactly like pi's `agent_end`.
Note `message_complete` carries only `{prompt_id}` — **usage comes from `GET /state`**
(`SessionStateSnapshot` has no top-level usage field in the schema; context meter is
read live via the state snapshot, mapped to `getUsage`). **⚠ CORRECTION to the plan's
"message_complete → runCompleted (+usage snapshot)": usage is not on the event; fetch
it separately.**

## 5. Host-UI + permissions — richer and differently-shaped than assumed ⚠ CORRECTION

### Interrogatives — 5 types, one endpoint

The plan said "interrogative (qna/confirm/input/select)". The actual
**`InterrogativeType`** enum is:

```
permission | confirmation | clarification | capability | plan_handoff
```

The `interrogative` event carries a discriminated payload (optional per-type context
objects, all nullable): `question`, `interrogative_type`, `clarification_options?`,
`extension_context?`, `plan_handoff?` (`PlanHandoffContext`), `permission_candidate_rule?`,
`permission_tool_call?`. Map to pilot's cards:
- `confirmation` → confirm card
- `clarification` (with `clarification_options` of `{key,label}`) → select card
- `capability` → a capability-grant card
- `plan_handoff` (with `PlanHandoffContext`: `plan_path`, `display_path`, `plan_text`,
  `target_facet`, `title`, `action_labels`) → the plan-handoff approval card (headline feature)
- `permission` → see permissions below

**Respond:** `POST /interrogative/{id}/respond` with **`InterrogativeResponse`** — a tagged union
on `kind`:

| `kind` | fields | maps to |
|---|---|---|
| `cancel` | — | dismiss card |
| `permission_answer` | `granted: bool`, `persistence_target?: PersistenceTarget` | approval decision |
| `confirmation_answer` | `confirmed: bool` | confirm reply |
| `clarification_choice` | `choice: string` (the option `key`) | select reply |
| `clarification_text` | `text: string` | free-text qna reply |
| `capability_answer` | `granted: bool` | capability reply |
| `plan_handoff_answer` | `decision: PlanHandoffDecision` | handoff reply |
| `ask_user_question_answers` | `answers: AskUserQuestionReply[]` | structured-question reply |

**`ask_user_question`** is a *separate* `DaemonEvent` variant (not the `interrogative`
event) — `{prompt_id, interrogative_id, payload: AskUserQuestionPayload}` where the
payload is `{questions: AskUserQuestion[]}`. Each `AskUserQuestion` mirrors the shape
this very agent exposes: `{id, question, mode: AskUserQuestionMode, context?, options?: AskUserQuestionOption[], allow_free_text}`.
Reply via the *same* `/interrogative/{id}/respond` with `kind:"ask_user_question_answers"`
and `answers: [{question_id, selected_option_ids?, free_text?}]`. So pilot reuses one
respond path for both.

### Permissions — 3 modes, 5 persistence targets (not 4+5 as the plan said)

The plan (citing docs) listed **four modes**: Standard / Autonomous / Bypass / Bypass+.
The **schema says three**:

**`PermissionMonitorMode`** (the `POST /permission-monitor` selector): `standard | bypass | autonomous`.

`PermissionMonitor` (the richer runtime state, on `permission_monitor_switch` and `GET
/permission-monitor`) is itself tagged: `standard`, `bypass`, or `autonomous{classifier_model?}`.
(There is no `bypass_plus` / `Bypass+` in the wire schema — that may be a docs-only or
future name. **⚠ CORRECTION**: pilot's mode switcher offers 3, not 4.)

**Approval scopes / persistence:** the plan said "Allow once / session / project-forever /
user-forever / No". The wire **`PersistenceTarget`** enum is:

```
session | project_local | project | user_local | user
```

Five levels, but **not "once"** — there is no one-shot persistence target. "Allow once" is
expressed as `permission_answer{granted:true, persistence_target:null}` (null = no
persistence = this occurrence only). The five named targets are the *durable* scopes,
splitting project/user into `_local` vs not. So pilot's approval card offers: **once (null) +
5 persistence targets**, and a **No** (`granted:false`). **⚠ CORRECTION**: 7 choices, not 5;
the `_local` distinction is new and needs UI thought.

`POST /permission-monitor {mode}` switches modes; `permission_monitor_switch{from_monitor, to_monitor}`
confirms. The classifier logic stays daemon-side — pilot renders, as the plan intended.

## 6. The `/events` SSE — liveness, cap, resume

- **Stream is push-only; no heartbeat frames unless there's activity.** An idle daemon
  emits nothing (confirmed: a 4-second SSE read on an idle daemon returned 0 bytes). So
  pilot's SSE liveness check must be time-based (frame gap), not expect periodic `heartbeat`
  events. The `heartbeat` event variant exists but is not emitted on a timer in this build —
  it appears only as a daemon-internal liveness tick on activity. **⚠ CORRECTION** to the
  plan's "heartbeat confirms SSE alive" — don't rely on periodic heartbeats.
- **503 `SSE subscriber cap reached`** is documented — there's a max subscriber count per
  daemon. Pilot's single subscriber per session is fine, but it means a *second* concurrent
  read-client (the "bonus" from §2) may be refused. Plan for pilot-exclusive.
- **`stream_discontinuity`** event (`{missed: int}`, "Subscriber-synthesized: events were
  dropped") is the gap signal — pilot should treat it as a re-seed trigger (`GET /history` +
  `GET /state`), like a reconnect. It carries `Envelope::seq = None`.
- **`Last-Event-ID`** resume: the `id:` field equals `seq`. Not spike-tested, but the shape
  supports it; confirm in Chunk 1.

## 7. Sessions, history, titles

- **History is a linear event log — confirmed, no branch DAG.** `GET /history?offset&limit`
  → `SessionHistorySnapshot {session_id, history_revision, total_projected_items, offset,
  items: SessionHistoryItem[]}`. `history_revision` is an int that bumps on change — use it
  to detect staleness when re-seeding. **Resolves D-B conclusively.**
- **`/rewind` is destructive — confirmed.** `RewindRequest {domains: string[], to_message_index?: int, to_prompt_id?: PromptId?}`.
  400 if the target splits a tool-call batch ("message index splits a tool call batch") —
  so rewind lands on clean boundaries, exactly as the docs said. `session_rewound` is the
  re-seed trigger. `branchFrom`/re-edit maps here; pilot's UX must warn "deletes everything
  after this point" (no safe branch-and-keep). **The `/tree` view is cut — nothing to branch.**
- **Auto-naming is daemon-native — confirmed.** `session_title_changed {title, source:
  "operator"|"inferred"}`. `inferred` = daemon inferred it. Pilot consumes the event; the
  `source` discriminator drives the one-time "auto-named" hint. `POST /title {title}`
  (empty string = clear override → revert to inferred); response gives the effective title
  + `overridden` flag. **Resolves D-C1.** (Not spike-confirmed that `inferred` is on by
  default at first run — but the model produced a `session_title` in `/health` immediately,
  so auto-naming is active without config.) **[OPEN: confirm default-on across a fresh
  config.]**
- **`GET /state`** → `SessionStateSnapshot`: `todos[]`, `flags[]`, `env{}`, `active_facet`,
  `active_model?`, `active_plan?`, `active_reasoning_effort?`, `adventurous_handoff_active`,
  `available_subagents[]`, `available_skills[]`, `plugin_config`, `project_cwd`. This is the
  re-broadcast seed on `openSession`/`session_state_changed`.

## 8. Other endpoints (mapping table confirmed)

| polytoken | shape | note |
|---|---|---|
| `POST /model` | `ModelRequest {model: string, reasoning_effort?: ReasoningEffort?}` | 400 unknown model; 409 turn in flight. reasoning_effort is the "thinking" lever |
| `POST /compact` | `null \| CompactRequest` | 202 accepted; 409 if in flight/suppressed/unconfigured |
| `POST /compact/{id}/cancel` | — | 404 if no active compaction |
| `POST /clear` | — | 409 if turn/compaction in flight |
| `POST /reload` | — | 200 applied; 409 turn in flight; 422 dynamic default unavailable |
| `POST /reset-shell` | — | `/clear` also resets shell; this does *only* that |
| `GET /files` | `{files: string[]}` (project-relative, dirs trailing `/`) | daemon-native file index — may replace pilot's `fd` |
| `GET /jobs` | `JobSnapshot[]` | background jobs (later) |
| `GET /subagent/{handle}/history` | raw subagent messages | nested view (later) |
| `POST /facet {facet}` | — | 200 switched; 422 unknown; 403 denied |
| `GET/POST /adventurous-handoff` | toggle flag | plan/execute auto-handoff |
| `POST /terminate` | — | graceful drain + exit (driver shutdown path) |
| `DELETE /todos/{id}` | — | 409 if has dependents or turn in flight |

### Provider auth — CLI/config, not daemon (confirmed) ✅

`polytoken auth provider` / `polytoken auth mcp` are CLI subcommands (not daemon endpoints).
So pilot's Settings "providers" panel shells out or edits config — the plan's read holds.
MCP OAuth *is* on the daemon (`/mcp/{server_name}/oauth/start|callback`), but provider auth
is not. `polytoken models` lists configured models + reasoning variants (for `listModels`).

## 9. Corrections to the plan — summary

| Plan claim | Spike finding | Impact |
|---|---|---|
| `PromptRequest` carries `deliverAs` + images | **Just `{content, max_tool_turns?}`** — no deliverAs, no images | steer/followUp is pilot-only; images need a separate path **[OPEN]** |
| Permission modes: Standard/Autonomous/Bypass/Bypass+ (4) | **`standard \| bypass \| autonomous`** (3) — no Bypass+ | mode switcher: 3 |
| Approval scopes: once/session/project-forever/user-forever/No (5) | **once(null) + `session\|project_local\|project\|user_local\|user`** (7 total) | approval card: 7 choices; `_local` split is new |
| `message_complete` carries usage | **usage is on `GET /state`, not the event** | fetch usage separately |
| `heartbeat` confirms SSE alive | **no periodic heartbeats on idle** — use frame-gap liveness | SSE health check is time-based |
| ~50 endpoints / 56 events | **40 paths / 57 event variants** | immaterial |
| `tool_call` vs `content_block_stop` ordering [VERIFY] | **`tool_call` is authoritative**; emit `toolStarted` there | accumulator emits on `tool_call` |

## 10. Open items for Chunk 1

- **Images in prompts.** `PromptRequest` is text-only; no documented image path. Confirm
  whether a daemon feature exists or pilot marks image-attach unsupported under this driver.
- **`Last-Event-ID` resume.** Shape supports it (`id:` == `seq`); implement + test in Chunk 1.
- **Auto-naming default-on** across a fresh config (strong signal it's on; not a blocker).
- **`Bypass+`** — absent from the v0.3.3 wire schema; either docs-ahead-of-code or renamed.
  Code to the 3-mode schema; revisit if a later daemon adds it.

## Status: Chunk 0 gate cleared

All six [VERIFY] targets are resolved against a live daemon + the binary's own schemas:
process-per-session, prompt/steer shapes, content_block delta shapes, interrogative +
permission payloads, history-is-linear (D-B), lease exclusivity. The event-fold accumulator
design in the plan is **empirically validated** (§4). The plan's phased work can proceed to
**Chunk 1 (codegen + skeleton)** with the corrected shapes above.
