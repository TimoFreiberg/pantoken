# polytoken — feature inventory

What the **polytoken daemon + TUI** expose, enumerated as thoroughly as I could from the
authoritative introspection surfaces and confirmed by driving the TUI/daemon through the
parity harness.

**Sources** (all read-only, captured 2026-06-30 against `polytoken 0.4.0-unstable.2`):
- `polytoken print-tui-command-actions` — 108 TUI keyboard actions / scopes
- `polytoken print-slash-commands` — the slash-command set
- `polytoken print-tools` — the agent tool catalog
- `polytoken openapi` — the daemon's full HTTP API (the real RPC surface)
- `polytoken event-schema` — the `DaemonEvent` wire envelope (~120 event variants)
- live TUI session in the isolated parity project (model `umans/umans-glm-5.2`)

> A polytoken **daemon serves one session on one port**; the TUI attaches over an
> **exclusive lease**. `/history` + `/state` are the single source of truth; the TUI is a
> projection of it. Everything below is a daemon capability surfaced through the TUI.

---

## 1. Conversation & turn lifecycle

| Feature | Notes (daemon / TUI) |
|---|---|
| Send a prompt | `POST /prompt`; TUI `Enter` submits, `Shift+Enter`/`Alt+Enter` newline |
| Streaming output | `content_block_delta`/`message_start`/`message_complete` events; assistant text streams token-by-token |
| Thinking / reasoning stream | `thinking`, `signature_delta`, `redacted_thinking`, `open_ai_reasoning_opaque` events; rendered as a separate, collapsible block |
| Tool-call cards | `tool_call`/`tool_use`/`tool_use_input`/`tool_result`/`tool_reveal`/`forced_tool_call`; live + replayed |
| Mid-turn input queue | `POST /turn/input` (`{content}` only — **no steer/followup discriminator**), `GET /turn/input`, `DELETE /turn/input/newest`; events `pending_turn_input_queued/dequeued/discarded/drained` |
| Cancel / abort a turn | `POST /turn/cancel` |
| Context-window meter | `GET /state` usage; `context_pressure`/`context_too_large` events |
| Compaction (summarize context) | `/compact` → `POST /compact` (+`/compact/{id}/cancel`); `compaction_started/complete/failed/cancelled/reset`, `post_compaction` |
| Clear working context | `/clear` (alias `/new`) → `POST /clear`; `context_cleared`/`post_context_cleared` (history untouched) |
| Empty-response / status nudges | `empty_response_nudge`, `empty_summary`, `task_tracking_nudge`, `todo_status_nudge`, `system_reminder` |

## 2. Rewind / branch / session tree

| Feature | Notes |
|---|---|
| Rewind to an earlier point | `/rewind` → `POST /rewind` (TUI rewind view + per-card `Ctrl+R`); **destructive** — drops the target prompt and everything after |
| Session tree navigation | TUI tree/conversation navigation (`Up/Down` cards, `Left/Right` collapse/expand, branch markers); the daemon's branch structure comes from `/history` |
| Session rewound event | `session_rewound` |

## 3. Models, reasoning, facets, permissions (the bottom-bar quartet)

| Feature | Notes |
|---|---|
| Switch model | `/model` (`/models`) → `POST /model`; tiered **Full/Mini** model pairs; `model_changed`/`model_switch`/`model_error`/`model_not_found`/`no_model_fits`/`eager_fallback_activated` |
| Reasoning/thinking level | TUI `[` / `]` cycle reasoning; per-model variants |
| Switch facet | `/facet` → `POST /facet`; TUI facet typeahead (`Shift+Tab`); shipped facets `execute` + `plan`; `facet_changed`/`facet_switch`. Facets change system prompt + available tools |
| Permission monitor mode | `/permissions` → `GET/POST /permission-monitor`; modes `standard` \| `bypass` \| `bypass_plus` \| `autonomous` (autonomous carries classifier model, rules, `max_consecutive_denials`); `permission_monitor_switch`, `permission_rule_message`, `classifier_decision` events |
| Notification autodrain | `GET/POST /notification-autodrain`; `notification_autodrain_switch`, `notification_queued`, `notifications_drained` |

## 4. Approvals / interrogatives (the daemon's structured-question channel)

One unified `interrogative` event stream, answered via `POST /interrogative/{id}/respond`.
`InterrogativeType` enum (live daemon, **6 values**):

| Type | Purpose |
|---|---|
| `permission` | Tool/command approval (the 7-choice permission prompt) |
| `confirmation` | Yes/no confirmation |
| `clarification` | Pick one of N options (or free text) |
| `capability` | Capability grant |
| `plan_handoff` | Approve a plan before plan→execute handoff |
| `goal_proposal` | **Approve an agent-proposed session goal** (new in 0.4.x) |
| `ask_user_question` | Separate `ask_user_question` event (1–4 structured questions, each allows free text), answered on the same endpoint |

## 5. Goals (saved-session goal driver)

| Feature | Notes |
|---|---|
| Set / show / pause / resume / clear goal | `/goal [set <text>\|pause\|resume\|clear]` → `GET/POST /goal`, `/goal/clear`, `/goal/pause`, `/goal/resume` |
| Agent-proposed goals | `propose_goal` tool → `goal_proposal` interrogative (unless `goal_driver.agent_goal_auto_accept`); `read_goal`/`complete_goal`/`block_goal` tools |
| Goal lifecycle events | `goal_driver_update`, `goal_reminder` |
| Goal display | TUI shows the goal in the status/sidebar area |

## 6. Todos, jobs, subagents (right-hand sidebar in the TUI)

| Feature | Notes |
|---|---|
| Todo list | `todo_create/update/complete/delete/list` tools; `DELETE /todos/{id}`; TUI **Todos pane** (`Ctrl+F4`) + `/todo`; `SessionStateSnapshot.todos[]` |
| Background jobs | `GET /jobs`, `GET /job/{handle}`, `/job/{handle}/cancel`, `/job/{handle}/output`; `/jobs` + TUI **Jobs pane** (`Ctrl+F3`); `job_*` events; tools `job_status/block/result/cancel` |
| Subagents | `subagent` tool runs as a background job; `GET /subagent/{handle}/history`; `subagent_*` / `subsession_*` events incl. `subsession_interrogative` |
| Flagged files | `flag_important` tool (`included`/`referenced`); `SessionStateSnapshot.flags[]`; TUI **flags pane** (`Ctrl+F2`) |

## 7. Plan mode

| Feature | Notes |
|---|---|
| Write/edit/handoff a plan | `write_plan`/`edit_plan`/`handoff_plan` tools; `plan` facet; `plan_mode_reinforcement`, `plan_review_required`, `plan_verification` events; built-in `plan-reviewer` subagent at handoff |

## 8. Agent tool catalog (`print-tools`)

- **File/project:** `file_read`/`file_read_hashline`, `file_edit_search_replace`/`file_edit_hashline`/`patch_edit`, `file_write`, `glob`, `grep`, `flag_important`
- **Shell/jobs:** `shell_exec`, `shell_monitor`, `pushd`/`popd`, `job_status`/`job_block`/`job_result`/`job_cancel`
- **Work/delegation:** `subagent`, `skill`, `todo_*`, `write_plan`/`edit_plan`/`handoff_plan`, `propose_goal`/`read_goal`/`complete_goal`/`block_goal`, `switch_facet`
- **Web/external:** `web_search`, `web_fetch`, `mcp_list_resources`, `mcp_read_resource`
- **Interaction:** `ask_user_question`, `tool_search`
- Tool-loading: `tool_exposure_changed`, `tool_reveal`, `tool_search` (on-demand tool definitions), `reload_affected_tool_loading`

## 9. Sessions & history

| Feature | Notes |
|---|---|
| Spawn / attach / continue / list | `polytoken new` / `attach` / `continue` / `sessions`; resume cold sessions from history |
| History + state snapshot | `GET /history`, `GET /state`; `session_start`, `session_resumed`, `session_state_changed` |
| Session title | `/title [text]` → `POST /title`; `session_title_changed`; inferred title when unset |
| Working dir | `pushd`/`popd` + `chdir`; `cwd_changed`, `working_directory_deleted` |
| TUI attach lease | `GET /tui-attachment`, `/claim`, `/heartbeat`, `DELETE /{lease_id}` (exclusive) |
| End / detach | `/quit` → `POST /terminate`; `/detach` releases the lease, daemon keeps running |

## 10. Providers, auth, config

| Feature | Notes |
|---|---|
| Providers & models config | `polytoken config` / `models`; catalog providers, custom models, model enable/disable, default model, Full/Mini tiers (TUI configurator) |
| Provider auth | `polytoken auth`; static API keys + **OAuth** (Anthropic Claude Pro/Max, OpenAI Codex, GitHub Copilot) via TUI provider login; `auth_failed`, `login_required`, `provider_error`, `rate_limited` |
| MCP servers | `/mcp` → `POST /mcp/{server}/enable\|disable\|disconnect\|reconnect`, `/mcp/{server}/oauth/start\|callback`; `mcp_server_connected/disabled/disconnected/reconnecting/enabled`; `mcp_list_resources`/`mcp_read_resource` tools |
| Daemon reload | `/daemon-reload` (`/reload`) → `POST /reload`; re-reads config, skills, facets, subagents, hooks, permissions, extensions, MCP without restart |
| Reset shell env | `/reset-shell` → `POST /reset-shell` |
| Extensions & skills | extensions load at session start; `skill` tool; `extension_registered`/`extension_message`; hooks `hook_fired`/`hook_result`/`hook_additional_context` |

## 11. Source control / diffs

| Feature | Notes |
|---|---|
| Source-control snapshot | `SessionStateSnapshot.source_control`; git metadata observed in history; edit tools can show bounded diffs in live tool cards |
| Adventurous handoff | `GET/POST /adventurous-handoff` |

## 12. TUI-surface affordances (interface-level, not daemon features)

Help overlay (`Ctrl+/`/`F1`), sidebar toggles (`Ctrl+Shift+B`, flags/jobs/todos panes), slash
palette (`/`), reference/@-file picker (`@`, with ignore-file toggle), history search (`Ctrl+R`),
external editor (`Ctrl+G`), copy card/prompt (`Ctrl+Y`), permission typeahead (`Ctrl+Shift+P`),
input-debug overlay (`/inputdebug`), version (`/version`), refresh (`/refresh`).

---

### Event taxonomy (for reference)

The `DaemonEvent` envelope has ~120 variants spanning: streaming (`content_block_*`,
`message_*`, `text`, `thinking`), tools (`tool_*`, `forced_tool_call`), compaction
(`compaction_*`, `post_compaction`), context (`context_*`), model (`model_*`,
`no_model_fits`, `eager_fallback_activated`), permissions (`permission_monitor_switch`,
`permission_rule_message`, `classifier_decision`), goals (`goal_driver_update`,
`goal_reminder`), jobs/subagents (`job_*`, `subagent_*`, `subsession_*`), MCP
(`mcp_server_*`), todos (`todo_status_nudge`, `task_tracking_nudge`), interrogatives
(`interrogative`, `ask_user_question`, `subsession_interrogative`), plan
(`plan_mode_reinforcement`, `plan_review_required`, `plan_verification`), rewind
(`session_rewound`), session (`session_start/resumed/state_changed/title_changed`,
`cwd_changed`, `working_directory_deleted`), hooks (`hook_*`), extensions
(`extension_*`), notifications (`notification_*`), auth (`auth_failed`, `login_required`,
`provider_error`, `rate_limited`), files (`file_reference`, `image_reference_resolved`),
skills (`skill_reference`), and system reminders.
