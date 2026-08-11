//! Mock driver for dev/e2e: directly implements PantokenDriver with fixture data.
//! Port of `server/src/mock-driver.ts` + `server/src/fixtures.ts`.
//!
//! The mock emits SessionDriverEvent[] directly (no daemon, no wire protocol).
//! This is what the e2e suite tests against.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use pantoken_protocol::session_driver::*;
use pantoken_protocol::wire::{DeliveryMode, McpAction, SessionAction};
use parking_lot::Mutex;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use crate::driver::{
    BranchResult, ClearQueueResult, DriverError, LeaseHolder, NewSessionOptsData, PantokenDriver,
    SessionSwitchError, TodoDeleteError,
};
use async_trait::async_trait;

/// Accessor for the requestId field shared by every HostUiRequest variant.
/// (Free function — we can't add an inherent impl on a type from another crate.)
fn request_id_of(r: &HostUiRequest) -> &str {
    match r {
        HostUiRequest::Confirm { request_id, .. }
        | HostUiRequest::Unknown { request_id, .. }
        | HostUiRequest::Input { request_id, .. }
        | HostUiRequest::Select { request_id, .. }
        | HostUiRequest::Editor { request_id, .. }
        | HostUiRequest::Qna { request_id, .. }
        | HostUiRequest::Plan { request_id, .. }
        | HostUiRequest::Permission { request_id, .. }
        | HostUiRequest::Notify { request_id, .. }
        | HostUiRequest::Status { request_id, .. }
        | HostUiRequest::Widget { request_id, .. }
        | HostUiRequest::Title { request_id, .. }
        | HostUiRequest::EditorText { request_id, .. }
        | HostUiRequest::Reset { request_id, .. } => request_id,
    }
}

// ── Fixture constants (ported from fixtures.ts) ─────────────────────────

pub(crate) const GREETING_PROMPT: &str =
    "Add a /health route to the server and a smoke test for it.";
const WORKSPACE_ID: &str = "ws-demo";
const WORKSPACE_PATH: &str = "/Users/timo/src/pantoken";
const SESSION_ID: &str = "demo-session";

/// The synthetic session list row prepended when a new session is created —
/// faithful port of TS `NEW_SESSION_ENTRY` (fixtures.ts). `new_session` spreads
/// the resolved cwd + a cwd-derived session id over this before prepending it.
const NEW_SESSION_PATH: &str = "/sessions/new-session.jsonl";
const NEW_SESSION_TITLE: &str = "New session";

/// Markdown showcase text (ported from fixtures.ts MARKDOWN_SAMPLE).
const MARKDOWN_SAMPLE: &str = "## Markdown showcase\n\nHere's **bold**, *italic*, ~~struck~~, and `inline code`, plus a [link](https://example.com).\n\n### A table\n\n| Feature     | Status |\n| ----------- | ------ |\n| Headers     | done   |\n| Tables      | done   |\n| Code blocks | done   |\n\n### A wide table\n\nA many-columned table is wider than a phone screen; it must scroll\nhorizontally instead of overflowing the viewport.\n\n| Country | Capital  | Population | Currency | Language   | Continent     | CallingCode |\n| ------- | -------- | ---------- | -------- | ---------- | ------------- | ----------- |\n| Japan   | Tokyo    | 125.7M     | JPY      | Japanese   | Asia          | +81         |\n| Brazil  | Brasília | 214.3M     | BRL      | Portuguese | South America | +55         |\n\n### A list\n\n1. First item\n2. Second item\n   - nested bullet\n   - another\n\n> A blockquote, for good measure.\n\n```ts\nfunction greet(name: string) {\n  return `hello, ${name}`;\n}\n```";

/// Plan handoff text (ported from fixtures.ts planHandoff()).
const PLAN_HANDOFF_TEXT: &str = "# Plan: Add facet indicator + plan-handoff card\n\n## Goal\nStop discarding plan-mode data the daemon already streams. Render the plan\nmarkdown in the handoff card and show a facet badge in the header.\n\n## Steps\n1. Add a `plan` variant to `HostUiRequest` in the protocol.\n2. Thread `plan_text` through the server event-map.\n3. Render markdown + refusal feedback in `ApprovalLayer.svelte`.\n4. Add a facet badge to `StatusHeader.svelte`.\n\n## Code\n```ts\ncase \"plan_handoff\": {\n  const ph = ev.plan_handoff;\n  const labels = ph\n    ? [ph.action_labels.implement_new_context,\n       ph.action_labels.implement_current_context,\n       ph.action_labels.cancel]\n    : [\"Implement (new context)\", \"Implement (current context)\", \"Cancel\"];\n  pending.planHandoffLabels = labels;\n}\n```\n\n## Risks\n- `plan_text` can be several KB; the card caps height at ~50vh and scrolls.\n- The default-facet sentinel is `\"execute\"`; a different default would show the\n  badge spuriously.\n\n## Verification\nThe handoff must preserve the daemon action order, keep implementation actions\nunchanged, and let an operator reject the plan with optional written feedback.\nThe refusal explanation is submitted through the dedicated plan-handoff decision,\nnot as a follow-up prompt.\n\n## Rollout\nAfter approval, the chosen implementation label round-trips through the existing\ninterrogative response endpoint. Older daemons may omit the refusal label, in which\ncase the legacy cancel label remains the explicit feedback affordance.\n\nOnce approved, the chosen label round-trips to a `plan_handoff_answer` decision\nvia the reverse mapping in `ui-bridge.ts` (no change needed there).";

/// Long context for the `qnatall` script — enough paragraphs to overflow the
/// QnA form's `.ctx` scroll region at the desktop viewport so scroll position
/// is observable and testable.
const LONG_QNA_CONTEXT: &str = "This question carries a long context block so the context region overflows and becomes scrollable. Read through it before answering; the relevant detail is spread across several paragraphs.\n\n**Background.** The form renders one question at a time inside a shared card. The context region (`.ctx`) is the sole scroll container on desktop, capped by the surrounding flex layout. When the context is taller than the available height, a scrollbar appears and the user can scroll within it.\n\n**Why this matters.** Each question should start scrolled to the top. If the scroll position carries over from a previous question, the user lands mid-context and has to scroll back up to find the beginning. That is the bug this fixture exists to exercise.\n\n**What to check.** After advancing to the next question, the context should be at `scrollTop === 0`. After going back to a previous question, the same should hold — scrolling one question must not affect any other.\n\n**Layout details.** The card is a flex column: the question text is pinned at the top, the context region shrinks and scrolls, and the options stay pinned at the bottom. The context region's height is a fraction of the form height, which itself is capped at roughly 70vh of the viewport.\n\n**Paragraph five.** Lorem-style filler follows to guarantee overflow at the standard 850px desktop viewport used by the e2e suite. Each paragraph adds a few lines of height; with enough of them the cumulative height exceeds the region's client height and scrolling becomes possible.\n\n**Paragraph six.** The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.\n\n**Paragraph seven.** A second block of filler text to add more height. A second block of filler text to add more height. A second block of filler text to add more height. A second block of filler text to add more height.\n\n**Paragraph eight.** Yet more content to be certain the region overflows even on taller viewports. Yet more content to be certain the region overflows even on taller viewports. Yet more content to be certain the region overflows even on taller viewports.\n\n**Paragraph nine.** Final filler paragraph. Final filler paragraph. Final filler paragraph. Final filler paragraph. Final filler paragraph. Final filler paragraph. Final filler paragraph. Final filler paragraph.";

/// Tiny deterministic PNGs (solid-color rectangles) for the images fixture.
const MOCKUP_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwE9pDFMazBQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEX9RS5koKflW4AAAAASUVORK5CYII=";
const SHOT_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAqElEQVR4nO3QAQkAIADAMFMaw5QGs4XCHTzA2dhr6kLj+cEngQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnSrA0Iub1g8jaYyAAAAAElFTkSuQmCC";

/// Monotonic mock clock — each call to `ts()` bumps by TS_STEP_MS and returns
/// a zero-padded 10-digit string, matching the TS fixture's `ts()` exactly.
const TS_STEP_MS: u64 = 5;
static MOCK_TS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn ts() -> String {
    let v = MOCK_TS.fetch_add(TS_STEP_MS, Ordering::Relaxed) + TS_STEP_MS;
    format!("{:0>10}", v)
}

/// Bump the mock clock by `ms` WITHOUT emitting an event — used between a tool's
/// start and finish so the derived duration badge reads realistically.
fn advance_ts(ms: u64) {
    MOCK_TS.fetch_add(ms, Ordering::Relaxed);
}

/// Reset the mock clock to zero (called on `reset()`).
fn reset_ts() {
    MOCK_TS.store(0, Ordering::Relaxed);
    LIVE_USAGE_TOKENS.store(47200, Ordering::Relaxed);
}

/// Live context meter — climbs each poll so it's visibly non-static during a run.
static LIVE_USAGE_TOKENS: AtomicU64 = AtomicU64::new(47200);

fn mock_session_ref() -> SessionRef {
    SessionRef {
        workspace_id: WORKSPACE_ID.into(),
        session_id: SESSION_ID.into(),
    }
}

fn mock_workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_id: WORKSPACE_ID.into(),
        path: WORKSPACE_PATH.into(),
        display_name: Some("pantoken".into()),
    }
}

fn mock_models() -> Vec<ModelOption> {
    vec![
        ModelOption {
            model_id: "anthropic/claude-opus-4-8".into(),
            label: "Claude Opus 4.8".into(),
            thinking_levels: Some(vec![
                "off".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
            default_thinking_level: Some("medium".into()),
        },
        ModelOption {
            model_id: "anthropic/claude-sonnet-4-6".into(),
            label: "Claude Sonnet 4.6".into(),
            thinking_levels: Some(vec![
                "off".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
            default_thinking_level: Some("medium".into()),
        },
        ModelOption {
            model_id: "deepseek/deepseek-v4-flash".into(),
            label: "DeepSeek V4 Flash".into(),
            thinking_levels: Some(vec!["off".into()]),
            default_thinking_level: Some("off".into()),
        },
        ModelOption {
            model_id: "openai/gpt-5".into(),
            label: "GPT-5".into(),
            thinking_levels: Some(vec![
                "minimal".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
            default_thinking_level: Some("medium".into()),
        },
    ]
}

fn mock_commands() -> Vec<CommandInfo> {
    // Daemon builtins that pantoken intercepts client-side. Mirrors the
    // non-omitted canonicals from commands.rs's OMITTED_CANONICALS (the
    // real driver parses these from `polytoken print-slash-commands`).
    let builtins = [
        ("clear", "Clears the working context"),
        ("compact", "Summarizes the context"),
        ("facet", "Switch the active facet"),
        ("reset-shell", "Restore the shell environment"),
        ("daemon-reload", "Reload daemon configuration"),
        ("goal", "Set, pause, resume, or clear the goal"),
        ("title", "Set the session title"),
        ("mcp", "Manage MCP servers"),
    ];
    let builtin_cmds: Vec<CommandInfo> = builtins
        .iter()
        .map(|(name, desc)| CommandInfo {
            name: (*name).into(),
            description: Some((*desc).into()),
            source: CommandSource::Builtin,
            argument_hint: None,
        })
        .collect();
    let mut cmds = builtin_cmds;
    cmds.extend(vec![
        CommandInfo {
            name: "review".into(),
            description: Some("Review the working-copy diff for bugs".into()),
            source: CommandSource::Prompt,
            argument_hint: Some("[path]".into()),
        },
        CommandInfo {
            name: "plan".into(),
            description: Some("Draft an implementation plan before coding".into()),
            source: CommandSource::Prompt,
            argument_hint: None,
        },
        CommandInfo {
            name: "commit".into(),
            description: Some("Stage changes and commit with a generated message".into()),
            source: CommandSource::Extension,
            argument_hint: None,
        },
        CommandInfo {
            name: "pr".into(),
            description: Some("Open a pull request for the current branch".into()),
            source: CommandSource::Extension,
            argument_hint: None,
        },
        CommandInfo {
            name: "skill:debug".into(),
            description: Some("Trace a bug end-to-end before forming a hypothesis".into()),
            source: CommandSource::Skill,
            argument_hint: None,
        },
        CommandInfo {
            name: "skill:journal".into(),
            description: Some("Capture a durable judgment for a future session".into()),
            source: CommandSource::Skill,
            argument_hint: None,
        },
    ]);
    cmds
}

fn mock_files() -> Vec<FileInfo> {
    // Faithful port of TS `MOCK_FILES` (`server/src/fixtures.ts:100-133`).
    vec![
        FileInfo {
            path: "README.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "AGENTS.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs".into(),
            is_directory: true,
        },
        FileInfo {
            path: "docs/DESIGN.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs/DECISIONS.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs/TODO.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs/ADR-desktop-shell.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server".into(),
            is_directory: true,
        },
        FileInfo {
            path: "server/src/index.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/hub.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/mock-driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/hub.test.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/fixtures.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/polytoken/polytoken-driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client".into(),
            is_directory: true,
        },
        FileInfo {
            path: "client/src/app.css".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/components/Composer.svelte".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/components/SlashMenu.svelte".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/store.svelte.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/slash.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/slash.test.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/ws.svelte.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "e2e".into(),
            is_directory: true,
        },
        FileInfo {
            path: "e2e/slash.e2e.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "e2e/composer-resize.e2e.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "protocol".into(),
            is_directory: true,
        },
        FileInfo {
            path: "protocol/src/wire.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "protocol/src/session-driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "protocol/src/state.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "package.json".into(),
            is_directory: false,
        },
        FileInfo {
            path: "tsconfig.json".into(),
            is_directory: false,
        },
    ]
}

/// Project-side Shift+Tab fixtures — a dotfile and a gitignored-looking build
/// artifact, deliberately absent from `mock_files()`'s always-visible list so
/// `list_files`'s ignore toggle has something project-mode-specific to reveal
/// (mirrors the real driver's `list_files_with_fd(include_ignored: true)`,
/// which surfaces dotfiles + gitignored entries that are hidden by default).
fn mock_ignored_files() -> Vec<FileInfo> {
    vec![
        FileInfo {
            path: ".env".into(),
            is_directory: false,
        },
        FileInfo {
            path: "dist/bundle.js".into(),
            is_directory: false,
        },
    ]
}

fn mock_skills() -> Vec<String> {
    vec!["debug".into(), "journal".into()]
}

fn mock_subagents() -> Vec<String> {
    vec!["reviewer".into(), "explorer".into()]
}

/// Scan a prompt's text for whitespace-delimited `@`-tokens and resolve them against
/// the mock's own fixtures — a deterministic stand-in for the real daemon's
/// `resolved_references` (`PromptAccepted.resolved_references`), so e2e can assert
/// chips without a live daemon. Deliberately dumb: no quoting/escaping awareness, no
/// fuzzy matching — a token either exactly matches a recognized `@kind:name` prefix
/// (kind-filtered against `mock_skills()`/`mock_subagents()`) or a known
/// `mock_files()` path, or it's silently skipped (most `@`s in a prompt aren't
/// references at all). `@model:` tokens aren't filtered against a fixture list — the
/// daemon accepts any modelId — so they always resolve. Duplicate mentions of
/// the same (kind, name) collapse to one chip, first-seen order.
fn parse_at_references(text: &str) -> Vec<ResolvedRef> {
    let skills = mock_skills();
    let subagents = mock_subagents();
    let files = mock_files();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for token in text.split_whitespace() {
        let Some(rest) = token.strip_prefix('@') else {
            continue;
        };
        let resolved = if let Some(name) = rest.strip_prefix("skill:") {
            skills
                .iter()
                .find(|s| s.as_str() == name)
                .map(|_| ResolvedRef {
                    kind: "skill".into(),
                    name: name.into(),
                    file_kind: None,
                })
        } else if let Some(name) = rest.strip_prefix("subagent:") {
            subagents
                .iter()
                .find(|s| s.as_str() == name)
                .map(|_| ResolvedRef {
                    kind: "subagent".into(),
                    name: name.into(),
                    file_kind: None,
                })
        } else if let Some(name) = rest.strip_prefix("model:") {
            Some(ResolvedRef {
                kind: "model".into(),
                name: name.into(),
                file_kind: None,
            })
        } else {
            files.iter().find(|f| f.path == rest).map(|f| ResolvedRef {
                kind: "file".into(),
                name: rest.into(),
                file_kind: Some(if f.is_directory { "directory" } else { "file" }.into()),
            })
        };
        if let Some(r) = resolved {
            if seen.insert((r.kind.clone(), r.name.clone())) {
                out.push(r);
            }
        }
    }
    out
}

fn mock_usage() -> SessionUsage {
    SessionUsage {
        tokens: Some(47200),
        context_window: 200000,
        percent: Some(23.6),
    }
}

fn mock_usage_full() -> SessionUsage {
    SessionUsage {
        tokens: Some(182000),
        context_window: 200000,
        percent: Some(91.0),
    }
}

/// Over-window fixture: `used_tokens` above `limit_tokens` (e.g. after a
/// large-output turn). The mock constructs `SessionUsage` directly and bypasses
/// `usage_from_state`, so the wire percent is the raw 200.0 — the client-side
/// `clampContextPercent` is the load-bearing clamp for this path (e2e drives it
/// via the `contextover` script).
fn mock_usage_over_window() -> SessionUsage {
    SessionUsage {
        tokens: Some(400000),
        context_window: 200000,
        percent: Some(200.0),
    }
}

pub(crate) fn session_ref_for(session_id: &str) -> SessionRef {
    SessionRef {
        workspace_id: WORKSPACE_ID.into(),
        session_id: session_id.into(),
    }
}

/// Build a snapshot with optional overrides, matching the TS `snapshot(over)` pattern.
fn snap(
    status: SessionStatus,
    facet: Option<String>,
    goal: Option<Option<GoalInfo>>,
    active_plan: Option<String>,
    flags: Option<Vec<FlaggedFile>>,
    todos: Option<Vec<TodoItem>>,
) -> SessionSnapshot {
    SessionSnapshot {
        r#ref: mock_session_ref(),
        workspace: mock_workspace(),
        title: "Wire up the WebSocket bridge".into(),
        status,
        updated_at: ts(),
        archived_at: None,
        preview: None,
        config: Some(mock_default_config()),
        usage: Some(mock_usage()),
        running_run_id: None,
        queued_messages: None,
        facet,
        permission_monitor: Some(PermissionMonitorMode::Standard),
        adventurous_handoff: Some(false),
        notification_autodrain: Some(false),
        active_plan,
        goal,
        flags,
        todos,
        mcp_servers: Some(mock_mcp_servers()),
        cwd: None,
        cwd_stack_depth: None,
    }
}

fn mock_snapshot(status: SessionStatus) -> SessionSnapshot {
    snap(status, None, None, None, None, None)
}

fn mock_mcp_servers() -> Vec<McpServerInfo> {
    vec![
        McpServerInfo {
            server_name: "filesystem".into(),
            status: McpServerStatus::Connected,
            tool_count: 11,
        },
        McpServerInfo {
            server_name: "github".into(),
            status: McpServerStatus::Disconnected,
            tool_count: 0,
        },
    ]
}

fn mock_default_config() -> SessionConfig {
    SessionConfig {
        model_id: Some("anthropic/claude-opus-4-8".into()),
        thinking_level: Some("medium".into()),
        available_thinking_levels: Some(vec![
            "off".into(),
            "low".into(),
            "medium".into(),
            "high".into(),
        ]),
    }
}

/// Default fixture jobs for the RightSidebar jobs section. Empty by default
/// (the empty-state test checks "No background jobs"); the `context` script
/// and the `jobs` script populate them.
fn mock_default_jobs() -> Vec<BackgroundJob> {
    vec![]
}

/// Fixture jobs for the `context` script — three jobs covering the main UI
/// states: a running subagent, a completed shell job, and a completed
/// subagent with output.
fn mock_context_jobs() -> Vec<BackgroundJob> {
    vec![
        BackgroundJob {
            handle: "general-purpose:code-reviewer".into(),
            kind: JobKind::Subagent,
            status: JobStatusKind::Running,
            tool_name: "subagent".into(),
            created_at: "2025-07-09T10:00:00Z".into(),
            started_at: Some("2025-07-09T10:00:01Z".into()),
            ended_at: None,
            updated_at: "2025-07-09T10:02:00Z".into(),
            subagent_type: Some("general-purpose".into()),
            model: Some("anthropic/claude-sonnet-4-20250514".into()),
            subagent_handle: Some("general-purpose:code-reviewer".into()),
            expiring: None,
            output_tail: Some("Reviewing src/store.svelte.ts...\nChecking type safety...\nFound 2 issues".into()),
            output_bytes: Some(1024),
        },
        BackgroundJob {
            handle: "shell:lint-check".into(),
            kind: JobKind::Shell,
            status: JobStatusKind::Completed,
            tool_name: "shell_exec".into(),
            created_at: "2025-07-09T09:30:00Z".into(),
            started_at: Some("2025-07-09T09:30:01Z".into()),
            ended_at: Some("2025-07-09T09:30:15Z".into()),
            updated_at: "2025-07-09T09:30:15Z".into(),
            subagent_type: None,
            model: None,
            subagent_handle: None,
            expiring: None,
            output_tail: Some("cargo clippy --all-targets\n    Finished in 14.2s\n0 warnings, 0 errors".into()),
            output_bytes: Some(512),
        },
        BackgroundJob {
            handle: "researcher:api-docs".into(),
            kind: JobKind::Subagent,
            status: JobStatusKind::Completed,
            tool_name: "subagent".into(),
            created_at: "2025-07-09T08:00:00Z".into(),
            started_at: Some("2025-07-09T08:00:01Z".into()),
            ended_at: Some("2025-07-09T08:05:30Z".into()),
            updated_at: "2025-07-09T08:05:30Z".into(),
            subagent_type: Some("researcher".into()),
            model: Some("anthropic/claude-sonnet-4-20250514".into()),
            subagent_handle: Some("researcher:api-docs".into()),
            expiring: None,
            output_tail: Some("Searched 5 sources for OpenAI Responses API tool calling.\nKey finding: tool_choice parameter accepts 'auto' | 'required' | specific tool.".into()),
            output_bytes: Some(2048),
        },
    ]
}

/// Isolated visual fixture for the RightSidebar pulse boundary: a running
/// subagent, a running shell, a completed shell, and a completed subagent.
fn mock_visual_jobs() -> Vec<BackgroundJob> {
    let mut jobs = mock_context_jobs();
    let mut running_shell = jobs[1].clone();
    running_shell.handle = "shell:running-check".into();
    running_shell.status = JobStatusKind::Running;
    running_shell.ended_at = None;
    running_shell.updated_at = "2025-07-09T09:31:00Z".into();
    running_shell.output_tail = Some("cargo test --workspace".into());
    jobs.insert(1, running_shell);
    jobs
}

/// Default fixture todos for the delete path. Matches the `context` script's
/// snapshot todos so the sidebar is consistent.
fn mock_default_todos() -> Vec<TodoItem> {
    vec![
        TodoItem {
            id: 1,
            title: "Wire up the right sidebar".into(),
            description: "Add protocol types, event-map threading, and the drawer component".into(),
            status: TodoStatus::InProgress,
            dependencies: vec![],
            created_at: Some("2025-07-09T10:00:00Z".into()),
        },
        TodoItem {
            id: 2,
            title: "Add e2e tests".into(),
            description: "Assert flagged files + todos render, toggle opens/closes".into(),
            status: TodoStatus::Pending,
            dependencies: vec![1],
            created_at: Some("2025-07-09T10:05:00Z".into()),
        },
        TodoItem {
            id: 3,
            title: "Review with subagent".into(),
            description: "Check type safety, overwrite-guard consistency, tooltips".into(),
            status: TodoStatus::Pending,
            dependencies: vec![2],
            created_at: Some("2025-07-09T10:10:00Z".into()),
        },
    ]
}

// mock_snapshot is defined above ( delegates to snap() with no overrides).

fn mock_session_list() -> Vec<SessionListEntry> {
    let now = chrono::Utc::now();
    // JS `new Date(...).toISOString()` → `YYYY-MM-DDTHH:mm:ss.SSSZ` (trailing Z,
    // exactly 3 fractional digits). chrono's default `to_rfc3339()` emits a
    // `+00:00` offset + up to 9 digits, which is NOT byte-faithful to the TS
    // wire format. Match `toISOString()` exactly via SecondsFormat::Millis + use_z.
    let iso_ago = |ms: i64| {
        (now - chrono::Duration::milliseconds(ms))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let day = 24 * 60 * 60 * 1000;
    vec![
        SessionListEntry {
            session_id: "demo-session".into(),
            path: "/sessions/demo-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(),
            display_name: Some("Wire up the WebSocket bridge".into()),
            preview: "Add a /health route to the server and a smoke test for it.".into(),
            user_message_count: 3,
            usage: Some(mock_usage()),
            updated_at: iso_ago(5 * 60_000),
            created_at: iso_ago(2 * day),
            last_user_message_at: iso_ago(6 * 60_000),
            parent_session_path: None,
            archived: false,
        },
        SessionListEntry {
            session_id: "older-session".into(),
            path: "/sessions/older-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(),
            display_name: Some("Explore the fold reducer".into()),
            preview: "How does foldEvent assemble the transcript?".into(),
            user_message_count: 5,
            usage: Some(SessionUsage {
                tokens: Some(164000),
                context_window: 200000,
                percent: Some(82.0),
            }),
            updated_at: iso_ago(2 * 60 * 60 * 1000),
            created_at: iso_ago(3 * day),
            last_user_message_at: iso_ago(2 * 60 * 60 * 1000 + 60_000),
            parent_session_path: None,
            archived: false,
        },
        SessionListEntry {
            session_id: "scratch-session".into(),
            path: "/sessions/scratch-session.jsonl".into(),
            cwd: "/Users/timo/src/scratch".into(),
            display_name: None,
            preview: "quick scratch session".into(),
            user_message_count: 1,
            usage: None,
            updated_at: iso_ago(6 * 60 * 60 * 1000),
            created_at: iso_ago(4 * day),
            last_user_message_at: iso_ago(6 * 60 * 60 * 1000 - 60_000),
            parent_session_path: None,
            archived: false,
        },
        // Regression fixture for the cold-restore collapse bug (docs/TODO.md): its
        // seed (`restored_session_seed`) mimics `history_to_seed_events` +
        // `build_branch_seed`'s replay shape — real tool work, settled via a bare
        // idle `SessionUpdated` re-assert rather than a `RunCompleted`. Own project
        // group (distinct cwd) so it can't perturb "pantoken" group row counts.
        SessionListEntry {
            session_id: "restored-session".into(),
            path: "/sessions/restored-session.jsonl".into(),
            cwd: "/Users/timo/src/retry-lib".into(),
            display_name: Some("Cold-restore regression check".into()),
            preview: "Refactor the retry helper to use exponential backoff.".into(),
            user_message_count: 1,
            usage: None,
            updated_at: iso_ago(90 * 60_000),
            created_at: iso_ago(day),
            last_user_message_at: iso_ago(90 * 60_000 + 60_000),
            parent_session_path: None,
            archived: false,
        },
        SessionListEntry {
            session_id: "archived-session".into(),
            path: "/sessions/archived-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(),
            display_name: Some("Archived experiment".into()),
            preview: "An old experiment I tucked away.".into(),
            user_message_count: 4,
            usage: None,
            updated_at: iso_ago(5 * day),
            created_at: iso_ago(8 * day),
            last_user_message_at: iso_ago(5 * day),
            parent_session_path: None,
            archived: true,
        },
        SessionListEntry {
            session_id: "stale-session".into(),
            path: "/sessions/stale-session.jsonl".into(),
            cwd: "/Users/timo/src/stale-proj".into(),
            display_name: Some("Old spike".into()),
            preview: "A spike from a couple of weeks ago.".into(),
            user_message_count: 2,
            usage: None,
            updated_at: iso_ago(10 * day),
            created_at: iso_ago(12 * day),
            last_user_message_at: iso_ago(10 * day),
            parent_session_path: None,
            archived: false,
        },
    ]
}

/// Resolve picker paths like the live driver: expand `~`, normalize `.`/`..`,
/// resolve relative paths from `$HOME`, and preserve absolute fixture paths.
fn mock_resolve(path: Option<&str>) -> String {
    use std::path::{Component, Path, PathBuf};
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let raw = path.map(|s| s.trim()).filter(|s| !s.is_empty());
    let Some(raw) = raw else { return home };
    let expanded = if raw == "~" {
        PathBuf::from(&home)
    } else if let Some(rest) = raw.strip_prefix("~/") {
        Path::new(&home).join(rest)
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        Path::new(&home).join(raw)
    };
    let mut out = PathBuf::from("/");
    for comp in expanded.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(c) => out.push(c),
            Component::RootDir | Component::Prefix(_) => {} // already rooted (out starts at "/")
        }
    }
    let s = out.to_string_lossy().into_owned();
    if s.is_empty() { "/".to_string() } else { s }
}

/// The synthetic directory tree for the new-session picker — faithful port of TS
/// `MOCK_DIR_LAYOUT` + `MOCK_DIR_TREE` (fixtures.ts / mock-driver.ts). Keyed by
/// absolute path under BOTH `$HOME` and `/Users/timo` (the fixture-cwd prefix) so
/// the picker has content regardless of the dev host's `$HOME`; child names are
/// stable. `demo`/`elsewhere` are empty project dirs e2e navigates into; `dirty`
/// simulates a project with uncommitted changes. The picker
/// (`list_dir`) reads this; `stat_path` reports existence from it. The mock never
/// touches the real disk.
fn mock_dir_tree() -> &'static std::collections::HashMap<String, Vec<String>> {
    use std::sync::OnceLock;
    static TREE: OnceLock<std::collections::HashMap<String, Vec<String>>> = OnceLock::new();
    TREE.get_or_init(|| {
        // rel-path → child names (TS MOCK_DIR_LAYOUT). "" is the root ($HOME).
        let layout: &[(&str, &[&str])] = &[
            (
                "",
                &["src", "Documents", "Downloads", "Projects", ".config"],
            ),
            (
                "src",
                &[
                    "pantoken",
                    "pi",
                    "pi-gui",
                    "kellercomm",
                    "scratch",
                    "demo",
                    "elsewhere",
                    "dirty",
                ],
            ),
            (
                "src/pantoken",
                &["client", "server", "protocol", "e2e", "docs"],
            ),
            ("src/pi", &["src", "docs", "examples"]),
            ("Documents", &["notes", "receipts"]),
            ("Projects", &["website"]),
            (".config", &["pi", "fish"]),
        ];
        let roots: Vec<String> =
            std::iter::once(std::env::var("HOME").unwrap_or_else(|_| String::new()))
                .chain(std::iter::once("/Users/timo".to_string()))
                .filter(|r| !r.is_empty())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
        let mut tree: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for root in &roots {
            for (rel, kids) in layout {
                let key = if rel.is_empty() {
                    root.clone()
                } else {
                    format!("{root}/{rel}")
                };
                tree.insert(key, kids.iter().map(|s| s.to_string()).collect());
            }
        }
        // Every listed child is an existing directory, including empty project dirs.
        // Keep explicit empty entries so `list_dir` can distinguish them from errors.
        let children: Vec<String> = tree
            .iter()
            .flat_map(|(parent, kids)| kids.iter().map(move |kid| format!("{parent}/{kid}")))
            .collect();
        for child in children {
            tree.entry(child).or_default();
        }
        tree
    })
}

/// The synthetic external filesystem for `@~/`, `@/`, `@../` browsing (the
/// composer's kind-aware `@`-picker) — the mock equivalent of the real
/// driver's `file_search::list_external`, but keyed directly on the AS-TYPED
/// directory prefix (`file_search::split_external_query`'s first element)
/// rather than a resolved absolute path, since the mock never touches the
/// real disk. Deliberately distinct from `mock_dir_tree()` above (the
/// new-session project picker's dirs-only tree): this one has files too, and
/// is addressed by literal query prefix instead of a real/faked absolute
/// path. `.secrets` under `~` is a hidden dotfile fixture (dotfile-hiding +
/// reveal-on-`.`-partial e2e assertions); `/etc` and `..` round out the
/// browsable set so all three lead-ins (`~`, `/`, `..`) have something to
/// show.
fn mock_external_tree() -> &'static HashMap<&'static str, Vec<(&'static str, bool)>> {
    use std::sync::OnceLock;
    static TREE: OnceLock<HashMap<&'static str, Vec<(&'static str, bool)>>> = OnceLock::new();
    TREE.get_or_init(|| {
        let mut m: HashMap<&'static str, Vec<(&'static str, bool)>> = HashMap::new();
        m.insert(
            "~",
            vec![
                ("notes.md", false),
                ("todo.txt", false),
                ("projects", true),
                (".secrets", false),
            ],
        );
        m.insert(
            "~/projects",
            vec![("pantoken", true), ("blog", true), ("readme.md", false)],
        );
        m.insert("/etc", vec![("hosts", false)]);
        m.insert("..", vec![("sibling-project", true), ("NOTES.md", false)]);
        m
    })
}

/// Faithful mock port of `file_search::list_external`: same split/filter/sort
/// rules (dirs first, then case-insensitive alphabetical; hidden dotfiles
/// excluded unless the partial itself starts with `.`), but looks the
/// as-typed directory prefix up in `mock_external_tree()` instead of
/// resolving + reading a real directory. An unknown prefix (not one of the
/// fixture's browsable dirs) yields an empty vec, same graceful-empty
/// behavior as a missing real directory. `include_ignored` mirrors the real
/// `list_external`'s Shift+Tab flag: when set, dotfiles are revealed
/// regardless of the partial (the OR condition below).
fn mock_list_external(query: &str, include_ignored: bool) -> Vec<FileInfo> {
    let (dir_prefix, partial) = crate::polytoken::file_search::split_external_query(query);
    let Some(children) = mock_external_tree().get(dir_prefix.as_str()) else {
        return Vec::new();
    };

    let partial_lower = partial.to_lowercase();
    let reveal_dotfiles = include_ignored || partial.starts_with('.');

    let mut entries: Vec<(&str, bool)> = children
        .iter()
        .copied()
        .filter(|(name, _)| reveal_dotfiles || !name.starts_with('.'))
        .filter(|(name, _)| partial.is_empty() || name.to_lowercase().contains(&partial_lower))
        .collect();

    entries.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    entries
        .into_iter()
        .map(|(name, is_dir)| FileInfo {
            path: crate::polytoken::file_search::join_prefix(&dir_prefix, name),
            is_directory: is_dir,
        })
        .collect()
}

// ── Script steps + event builders ──────────────────────────────────────

fn base() -> SessionEventBase {
    SessionEventBase {
        session_ref: mock_session_ref(),
        timestamp: ts(),
        run_id: None,
        subagent_handle: None,
    }
}

/// Like `base()` but stamps a specific session ref — used by `respond_ui`, which
/// must emit under the dialog's session (not always the default mock session),
/// mirroring TS `respondUi`'s `pending?.sessionRef ?? SESSION_REF`.
fn base_with_ref(session_ref: SessionRef) -> SessionEventBase {
    SessionEventBase {
        session_ref,
        timestamp: ts(),
        run_id: None,
        subagent_handle: None,
    }
}

/// Build a session-specific seed for opening a given session path.
/// Mirrors the TS `mockSessionSeed(path)` — returns different fixture content
/// per session so switching to "older-session" shows its own transcript, not
/// the greeting's.
fn mock_session_seed(path: &str) -> Vec<SessionDriverEvent> {
    fn session_seed(
        session_id: &str,
        title: &str,
        user_text: &str,
        assistant_text: &str,
    ) -> Vec<SessionDriverEvent> {
        let ref_id = session_ref_for(session_id);
        let b = || SessionEventBase {
            session_ref: ref_id.clone(),
            timestamp: ts(),
            run_id: None,
            subagent_handle: None,
        };
        let snap = |status: SessionStatus| SessionSnapshot {
            r#ref: ref_id.clone(),
            workspace: mock_workspace(),
            title: title.into(),
            status,
            updated_at: ts(),
            archived_at: None,
            preview: None,
            config: Some(mock_default_config()),
            usage: None,
            running_run_id: None,
            queued_messages: None,
            facet: None,
            permission_monitor: None,
            adventurous_handoff: None,
            notification_autodrain: None,
            active_plan: None,
            goal: None,
            flags: None,
            todos: None,
            mcp_servers: None,
            cwd: None,
            cwd_stack_depth: None,
        };
        vec![
            SessionDriverEvent::SessionOpened {
                base: b(),
                snapshot: snap(SessionStatus::Idle),
            },
            SessionDriverEvent::UserMessage {
                base: b(),
                id: format!("u-{session_id}"),
                text: user_text.into(),
                images: None,
                entry_id: None,
                references: None,
            },
            SessionDriverEvent::AssistantDelta {
                base: b(),
                text: assistant_text.into(),
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
            SessionDriverEvent::RunCompleted {
                base: b(),
                snapshot: snap(SessionStatus::Idle),
                user_entry_id: None,
                assistant_entry_id: None,
            },
        ]
    }
    match path {
        "/sessions/demo-session.jsonl" => greeting_seed(),
        "/sessions/older-session.jsonl" => older_session_seed(),
        "/sessions/scratch-session.jsonl" => session_seed(
            "scratch-session",
            "scratch",
            "quick scratch session",
            "Noted — nothing else here.",
        ),
        "/sessions/restored-session.jsonl" => restored_session_seed(),
        _ => session_seed(
            "unknown",
            "Session",
            "(opened)",
            "No fixture for this session.",
        ),
    }
}

/// The `older-session` fixture: a 5-turn session (matching its session-list
/// `user_message_count: 5`) about the fold reducer, with realistic tool spans
/// and a settled `RunCompleted` per turn. It must stay TALL enough to scroll at
/// the small viewports the polish scroll-position specs use — the old 1-turn
/// seed was shorter than the transcript fold once the dev bar and sidebars
/// squeezed the layout, which broke "switching sessions restores the saved
/// reading position". Turn 1 (the "How does foldEvent assemble the transcript?"
/// Q&A) is preserved verbatim — `cross-session-attention.e2e.ts` and
/// `lease-conflict.e2e.ts` assert on it, and `reconnect-focus.e2e.ts` asserts
/// the assistant reply.
fn older_session_seed() -> Vec<SessionDriverEvent> {
    let ref_id = session_ref_for("older-session");
    let b = || SessionEventBase {
        session_ref: ref_id.clone(),
        timestamp: ts(),
        run_id: None,
        subagent_handle: None,
    };
    let snap = |status: SessionStatus| SessionSnapshot {
        r#ref: ref_id.clone(),
        workspace: mock_workspace(),
        title: "Explore the fold reducer".into(),
        status,
        updated_at: ts(),
        archived_at: None,
        preview: None,
        config: Some(mock_default_config()),
        usage: None,
        running_run_id: None,
        queued_messages: None,
        facet: None,
        permission_monitor: None,
        adventurous_handoff: None,
        notification_autodrain: None,
        active_plan: None,
        goal: None,
        flags: None,
        todos: None,
        mcp_servers: None,
        cwd: None,
        cwd_stack_depth: None,
    };
    let user = |id: &str, text: &str| SessionDriverEvent::UserMessage {
        base: b(),
        id: id.into(),
        text: text.into(),
        images: None,
        entry_id: Some(format!("e-{id}")),
        references: None,
    };
    let reply = |text: &str| SessionDriverEvent::AssistantDelta {
        base: b(),
        text: text.into(),
        channel: Some(AssistantDeltaChannel::Text),
        entry_id: None,
    };
    let tool = |call_id: &str,
                name: &str,
                label: &str,
                input: serde_json::Value,
                output: serde_json::Value,
                dur_ms: u64| {
        let started = SessionDriverEvent::ToolStarted {
            base: b(),
            call_id: call_id.into(),
            tool_name: name.into(),
            label: Some(label.into()),
            description: None,
            input: Some(input),
        };
        advance_ts(dur_ms);
        let finished = SessionDriverEvent::ToolFinished {
            base: b(),
            call_id: call_id.into(),
            success: true,
            output: Some(output),
            images: None,
            interrupted: None,
        };
        (started, finished)
    };

    let mut events = vec![SessionDriverEvent::SessionOpened {
        base: b(),
        snapshot: snap(SessionStatus::Idle),
    }];

    // Turn 1 — preserved verbatim from the original single-turn seed.
    advance_ts(5 * 60_000);
    events.push(user(
        "u-older-1",
        "How does foldEvent assemble the transcript?",
    ));
    events.push(reply("It folds each driver event into render-ready items — assistant deltas accumulate into one bubble, tool cards key off callId, and ambient UI lives in keyed maps."));
    advance_ts(2 * 60_000);
    events.push(SessionDriverEvent::RunCompleted {
        base: b(),
        snapshot: snap(SessionStatus::Idle),
        user_entry_id: Some("e-u-older-1".into()),
        assistant_entry_id: Some("e-a-older-1".into()),
    });

    // Turn 2 — where the WS singleton lives and how messages enter the fold.
    advance_ts(20 * 60_000);
    events.push(user(
        "u-older-2",
        "Where does the reconnecting WebSocket singleton live and how do inbound events enter the fold?",
    ));
    events.push(reply("The singleton lives in `client/src/lib/ws.ts` — one socket per app, auto-reconnecting with backoff. Each inbound message runs through the same `foldEvent` reducer the server uses, so client state stays a pure derivation of the event log."));
    let (s, f) = tool(
        "o2-bash",
        "bash",
        "Run shell command",
        serde_json::json!({"command": "rg -n \"foldEvent\" client/src/lib"}),
        serde_json::json!(
            "client/src/lib/ws.ts:88:  const next = foldEvent(state, msg)\nclient/src/lib/store.svelte.ts:301:  applyEvent(foldEvent(state, evt))"
        ),
        1400,
    );
    events.push(s);
    events.push(f);
    events.push(reply("Reconnect and re-subscribe happen in the same file: the socket swap folds a synthetic `Reconnected` event so the reducer stays the single source of truth for ordering."));
    advance_ts(30 * 60_000);
    events.push(SessionDriverEvent::RunCompleted {
        base: b(),
        snapshot: snap(SessionStatus::Idle),
        user_entry_id: Some("e-u-older-2".into()),
        assistant_entry_id: Some("e-a-older-2".into()),
    });

    // Turn 3 — how the phone context panel reuses the desktop transcript.
    advance_ts(25 * 60_000);
    events.push(user(
        "u-older-3",
        "How does the mobile context panel reuse the desktop transcript component?",
    ));
    events.push(reply("It's the same `Transcript` component — the phone's full-screen context view swaps the wrapping layout via viewport-driven CSS, not a second implementation. Toggle state and scroll position are per-view so switching never resets your place."));
    let (s, f) = tool(
        "o3-read",
        "read",
        "Read file",
        serde_json::json!({"path": "client/src/components/Transcript.svelte"}),
        serde_json::json!("@media (max-width: 600px) { .transcript-wrap { padding: 0 12px; } }"),
        900,
    );
    events.push(s);
    events.push(f);
    events.push(reply("The shared fold reducer is what makes this cheap: both surfaces render the same item shapes, so the only mobile-specific work is chrome, not data plumbing."));
    advance_ts(35 * 60_000);
    events.push(SessionDriverEvent::RunCompleted {
        base: b(),
        snapshot: snap(SessionStatus::Idle),
        user_entry_id: Some("e-u-older-3".into()),
        assistant_entry_id: Some("e-a-older-3".into()),
    });

    // Turn 4 — flagged files across archive.
    advance_ts(40 * 60_000);
    events.push(user(
        "u-older-4",
        "What happens to flagged files when a session is archived?",
    ));
    events.push(reply("Flagged files live in the session snapshot, so archiving persists them — reopening the session restores the flags exactly. The sidebar just stops listing archived sessions; nothing about the transcript or context is dropped."));
    let (s, f) = tool(
        "o4-grep",
        "grep",
        "Search files",
        serde_json::json!({"pattern": "archived", "path": "protocol"}),
        serde_json::json!("protocol/src/state.ts:112:  archivedAt: string | null"),
        800,
    );
    events.push(s);
    events.push(f);
    advance_ts(45 * 60_000);
    events.push(SessionDriverEvent::RunCompleted {
        base: b(),
        snapshot: snap(SessionStatus::Idle),
        user_entry_id: Some("e-u-older-4".into()),
        assistant_entry_id: Some("e-a-older-4".into()),
    });

    // Turn 5 — the parity harness.
    advance_ts(15 * 60_000);
    events.push(user(
        "u-older-5",
        "Is there a parity harness for the TUI, and how does it stay isolated?",
    ));
    events.push(reply("Yes — `parity/` drives the GUI and the TUI against one shared isolated test project on fresh ports, so it can never touch a real daemon or the production registry."));
    let (s, f) = tool(
        "o5-read",
        "read",
        "Read file",
        serde_json::json!({"path": "parity/README.md"}),
        serde_json::json!(
            "# Parity harness\nSpins both surfaces on FRESH ports with an isolated sessions registry."
        ),
        1100,
    );
    events.push(s);
    events.push(f);
    events.push(reply("The harness asserts GUI⇄TUI parity by replaying the same scripted session on both and diffing the resulting transcripts."));
    advance_ts(50 * 60_000);
    events.push(SessionDriverEvent::RunCompleted {
        base: b(),
        snapshot: snap(SessionStatus::Idle),
        user_entry_id: Some("e-u-older-5".into()),
        assistant_entry_id: Some("e-a-older-5".into()),
    });

    events
}

/// Build the greeting fixture: sessionOpened + userMessage + assistant deltas + tool spans + runCompleted.
/// This is the seed every fresh client sees.
fn branched_seed() -> Vec<SessionDriverEvent> {
    vec![SessionDriverEvent::SessionOpened {
        base: base(),
        snapshot: mock_snapshot(SessionStatus::Idle),
    }]
}

fn greeting_seed() -> Vec<SessionDriverEvent> {
    let mut events = vec![
        SessionDriverEvent::SessionOpened {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
        },
        SessionDriverEvent::UserMessage {
            base: base(),
            id: "u1".into(),
            text: GREETING_PROMPT.into(),
            entry_id: Some("e-u1".into()),
            images: None,
            references: None,
        },
    ];

    // Simulate ~37s of working wall-clock between the prompt and the settled reply,
    // so the collapsed "Worked for Ns" header reads realistically on first load.
    advance_ts(36_600);

    // Assistant deltas (text channel, chunked)
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in deltas(text, 3) {
        events.push(SessionDriverEvent::AssistantDelta {
            base: base(),
            text: chunk,
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        });
    }

    // Tool span: bash (rg) — bump the clock by durationMs between start and finish.
    events.push(SessionDriverEvent::ToolStarted {
        base: base(),
        call_id: "t1".into(),
        tool_name: "bash".into(),
        label: Some("Run shell command".into()),
        description: Some("Execute a command in the workspace shell".into()),
        input: Some(serde_json::json!({"command": "rg -n \"app.get\\(\" server/src"})),
    });
    advance_ts(340);
    events.push(SessionDriverEvent::ToolFinished {
        base: base(), call_id: "t1".into(), success: true,
        output: Some(serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)")),
        images: None,
        interrupted: None,
    });

    // Second tool span — a read of the routes file (keeps the default visual
    // baseline showing a collapsed "Worked for Ns" block under the ≥2 threshold).
    events.push(SessionDriverEvent::ToolStarted {
        base: base(),
        call_id: "t2".into(),
        tool_name: "read".into(),
        label: Some("Read file".into()),
        description: Some("Read the contents of a file".into()),
        input: Some(serde_json::json!({"path": "server/src/index.ts"})),
    });
    advance_ts(260);
    events.push(SessionDriverEvent::ToolFinished {
        base: base(),
        call_id: "t2".into(),
        success: true,
        output: Some(serde_json::json!(
            "app.get('/health', (req, res) => { res.json({ ok: true }) })"
        )),
        images: None,
        interrupted: None,
    });

    // More assistant deltas
    let text2 = "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.";
    for chunk in deltas(text2, 3) {
        events.push(SessionDriverEvent::AssistantDelta {
            base: base(),
            text: chunk,
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        });
    }

    // Run completed
    events.push(SessionDriverEvent::RunCompleted {
        base: base(),
        snapshot: mock_snapshot(SessionStatus::Idle),
        user_entry_id: Some("e-u1".into()),
        assistant_entry_id: Some("e-a1".into()),
    });

    events
}

/// A COLD-RESTORED session's seed: the shape `history_to_seed_events` (server/
/// pantoken-server/src/polytoken/history_seed.rs) + the `build_branch_seed` wrapper
/// (server/pantoken-server/src/polytoken/driver.rs:755-795) produce when the
/// polytoken driver reopens a session with real tool work from `GET /history` —
/// deliberately NOT what a live-settled turn looks like (contrast `greeting_seed`/
/// `session_seed` above, which end on a proper `RunCompleted`). The defining trait:
/// daemon history replay has no `runCompleted` record to synthesize, so the trailing
/// bubble is settled by a bare idle `SessionUpdated` re-assert instead — no entryId
/// backfill (`stampLastEntryId` only runs on `runCompleted`), no `interruptRunningTools`
/// pass. The mock has no daemon history to replay, so nothing else reaches this shape;
/// it exists to give `open_session`/`reload_session` a deterministic fixture for it.
/// Regression bed for docs/TODO.md: "The feature that collapses the early working part
/// of a turn when the final message is written seems to not be triggered when a cold
/// session is restored in the GUI."
fn restored_session_seed() -> Vec<SessionDriverEvent> {
    let ref_id = session_ref_for("restored-session");
    let b = || SessionEventBase {
        session_ref: ref_id.clone(),
        timestamp: ts(),
        run_id: None,
        subagent_handle: None,
    };
    let snap = || SessionSnapshot {
        r#ref: ref_id.clone(),
        workspace: mock_workspace(),
        title: "Cold-restore regression check".into(),
        status: SessionStatus::Idle,
        updated_at: ts(),
        archived_at: None,
        preview: None,
        config: Some(mock_default_config()),
        usage: None,
        running_run_id: None,
        queued_messages: None,
        facet: None,
        permission_monitor: None,
        adventurous_handoff: None,
        notification_autodrain: None,
        active_plan: None,
        goal: None,
        flags: None,
        todos: None,
        mcp_servers: None,
        cwd: None,
        cwd_stack_depth: None,
    };
    vec![
        // The leading snapshot (build_branch_seed's first element).
        SessionDriverEvent::SessionOpened {
            base: b(),
            snapshot: snap(),
        },
        SessionDriverEvent::UserMessage {
            base: b(),
            id: "u-restored-1".into(),
            text: "Refactor the retry helper to use exponential backoff.".into(),
            images: None,
            entry_id: Some("e-u-restored-1".into()),
            references: None,
        },
        SessionDriverEvent::AssistantDelta {
            base: b(),
            text: "Sure — let me check the current implementation first.".into(),
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: Some("e-a-restored-1".into()),
        },
        SessionDriverEvent::ToolStarted {
            base: b(),
            call_id: "restored-t1".into(),
            tool_name: "bash".into(),
            label: Some("Run shell command".into()),
            description: Some("Execute a command in the workspace shell".into()),
            input: Some(serde_json::json!({"command": "rg -n \"function retry\" src"})),
        },
        SessionDriverEvent::ToolFinished {
            base: b(),
            call_id: "restored-t1".into(),
            success: true,
            output: Some(serde_json::json!(
                "src/retry.ts:3:export function retry(fn) {"
            )),
            images: None,
            interrupted: None,
        },
        SessionDriverEvent::ToolStarted {
            base: b(),
            call_id: "restored-t2".into(),
            tool_name: "read".into(),
            label: Some("Read file".into()),
            description: Some("Read the contents of a file".into()),
            input: Some(serde_json::json!({"path": "src/retry.ts"})),
        },
        SessionDriverEvent::ToolFinished {
            base: b(),
            call_id: "restored-t2".into(),
            success: true,
            output: Some(serde_json::json!(
                "export function retry(fn) {\n  // exponential backoff\n}"
            )),
            images: None,
            interrupted: None,
        },
        SessionDriverEvent::AssistantDelta {
            base: b(),
            text: "Done — `retry()` now backs off exponentially with a capped delay.".into(),
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: Some("e-a-restored-1".into()),
        },
        // The trailing re-assert build_branch_seed appends AFTER replayed history
        // (driver.rs:784-793) — a bare SessionUpdated, never a runCompleted. This is
        // the ONLY thing that closes the final assistant bubble on this path.
        SessionDriverEvent::SessionUpdated {
            base: b(),
            snapshot: snap(),
        },
    ]
}

/// Split text into streaming deltas of ~n words, preserving whitespace.
/// Matches the TS `deltas()` which splits on `/(\s+)/` (capturing) so the
/// fold's raw concatenation reproduces the original text exactly.
fn deltas(text: &str, chunk: usize) -> Vec<String> {
    let parts: Vec<&str> = text.split_inclusive(|c: char| c.is_whitespace()).collect();
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut n = 0;
    for w in &parts {
        buf.push_str(w);
        // Count word groups (non-whitespace runs) to decide when to flush.
        if w.trim().is_empty() {
            continue;
        }
        n += 1;
        if n % chunk == 0 {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

/// Render submitted Q&A into the same transcript text the answer extension's
/// `formatQnA` produces (Q / context / Options / A lines), so the mock exercises
/// the client's parse-and-render path. Faithful port of TS `formatQnaText`.
fn format_qna_text(questions: &[QnaQuestion], answers: &[QnaAnswer]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (i, q) in questions.iter().enumerate() {
        let a = answers.get(i);
        parts.push(format!("Q: {}", q.question));
        if let Some(ctx) = &q.context {
            parts.push(format!("> {ctx}"));
        }
        let opts: &[QnaQuestionOption] = q.options.as_deref().unwrap_or(&[]);
        let has_options = !opts.is_empty();
        if has_options {
            let picked: std::collections::HashSet<i64> = a
                .map(|ans| ans.selected_option_indices.iter().copied().collect())
                .unwrap_or_default();
            parts.push("Options:".into());
            for (j, opt) in opts.iter().enumerate() {
                let mark = if picked.contains(&(j as i64)) {
                    "[x]"
                } else {
                    "[ ]"
                };
                parts.push(format!("  {mark} {}", opt.label));
            }
        }
        let chosen: Vec<String> = match a {
            Some(ans) => ans
                .selected_option_indices
                .iter()
                .filter(|&&idx| idx >= 0 && (idx as usize) < opts.len())
                .map(|&idx| opts[idx as usize].label.clone())
                .collect(),
            None => Vec::new(),
        };
        let mut segments = chosen;
        let custom = a
            .map(|ans| ans.custom_text.trim().to_string())
            .unwrap_or_default();
        if !custom.is_empty() {
            segments.push(if has_options {
                format!("(typed) {custom}")
            } else {
                custom
            });
        }
        let answer = if segments.is_empty() {
            "(no answer)".to_string()
        } else {
            segments.join(", ")
        };
        parts.push(format!("A: {answer}"));
        parts.push(String::new());
    }
    parts.join("\n").trim_end().to_string()
}

/// Script step for delayed playback.
struct ScriptStep {
    wait_ms: u64,
    event: SessionDriverEvent,
}

/// Build a plan-handoff request with the shared daemon action order. The optional
/// refusal label deliberately stays separate from the legacy three labels so the
/// legacy fixture exercises omission rather than a synthetic fourth action.
fn plan_request(
    request_id: &str,
    title: &str,
    plan_text: &str,
    refuse_label: Option<&str>,
    timeout_ms: Option<i64>,
) -> ScriptStep {
    ScriptStep {
        wait_ms: 0,
        event: SessionDriverEvent::HostUiRequest {
            base: base(),
            request: HostUiRequest::Plan {
                request_id: request_id.into(),
                title: title.into(),
                plan_text: plan_text.into(),
                display_path: Some("plan.md".into()),
                target_facet: Some("execute".into()),
                action_labels: [
                    "Implement (new context)".into(),
                    "Implement (current context)".into(),
                    "Cancel".into(),
                ],
                refuse_label: refuse_label.map(str::to_owned),
                timeout_ms,
            },
        },
    }
}

/// A matched toolStarted → toolFinished pair with a deterministic duration.
/// Bumps the clock by `duration_ms` between stamping the two events so the
/// card's elapsed badge reads realistically.
#[allow(
    clippy::too_many_arguments,
    reason = "mock fixture helper mirrors scripted tool event fields"
)]
fn tool_span(
    call_id: &str,
    tool_name: &str,
    label: &str,
    description: Option<&str>,
    input: serde_json::Value,
    success: bool,
    output: serde_json::Value,
    start_wait: u64,
    wait_ms: u64,
    duration_ms: u64,
) -> Vec<ScriptStep> {
    let mut steps = vec![ScriptStep {
        wait_ms: start_wait,
        event: SessionDriverEvent::ToolStarted {
            base: base(),
            call_id: call_id.into(),
            tool_name: tool_name.into(),
            label: Some(label.into()),
            description: description.map(|d| d.into()),
            input: Some(input),
        },
    }];
    advance_ts(duration_ms);
    steps.push(ScriptStep {
        wait_ms,
        event: SessionDriverEvent::ToolFinished {
            base: base(),
            call_id: call_id.into(),
            success,
            output: Some(output),
            images: None,
            interrupted: None,
        },
    });
    steps
}

/// Build the greeting script (with delays for streaming).
#[expect(
    dead_code,
    reason = "fixture kept for mock parity; current default seed uses a prebuilt greeting session"
)]
fn greeting_script() -> Vec<ScriptStep> {
    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionOpened {
                base: base(),
                snapshot: mock_snapshot(SessionStatus::Idle),
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: base(),
                id: "u1".into(),
                text: GREETING_PROMPT.into(),
                entry_id: Some("e-u1".into()),
                images: None,
                references: None,
            },
        },
    ];

    advance_ts(36_600);

    // Assistant deltas with delays
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in deltas(text, 3) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    // Tool span
    steps.push(ScriptStep {
        wait_ms: 120,
        event: SessionDriverEvent::ToolStarted {
            base: base(),
            call_id: "t1".into(),
            tool_name: "bash".into(),
            label: Some("Run shell command".into()),
            description: Some("Execute a command in the workspace shell".into()),
            input: Some(serde_json::json!({"command": "rg -n \"app.get\\(\" server/src"})),
        },
    });
    advance_ts(340);
    steps.push(ScriptStep { wait_ms: 220, event: SessionDriverEvent::ToolFinished {
        base: base(), call_id: "t1".into(), success: true,
        output: Some(serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)")),
        images: None,
        interrupted: None,
    }});

    // Second tool span — a read of the routes file (keeps the default visual
    // baseline showing a collapsed "Worked for Ns" block under the ≥2 threshold).
    steps.push(ScriptStep {
        wait_ms: 80,
        event: SessionDriverEvent::ToolStarted {
            base: base(),
            call_id: "t2".into(),
            tool_name: "read".into(),
            label: Some("Read file".into()),
            description: Some("Read the contents of a file".into()),
            input: Some(serde_json::json!({"path": "server/src/index.ts"})),
        },
    });
    advance_ts(260);
    steps.push(ScriptStep {
        wait_ms: 180,
        event: SessionDriverEvent::ToolFinished {
            base: base(),
            call_id: "t2".into(),
            success: true,
            output: Some(serde_json::json!(
                "app.get('/health', (req, res) => { res.json({ ok: true }) })"
            )),
            images: None,
            interrupted: None,
        },
    });

    // More deltas
    let text2 = "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.";
    for chunk in deltas(text2, 3) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    // Run completed
    steps.push(ScriptStep {
        wait_ms: 60,
        event: SessionDriverEvent::RunCompleted {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
            user_entry_id: Some("e-u1".into()),
            assistant_entry_id: Some("e-a1".into()),
        },
    });

    steps
}

/// Build a prompt reply script — faithful port of TS `promptReply()`.
/// Emits: userMessage (with stable branch handles) → sessionUpdated(running) →
/// thinking deltas → text deltas → read tool span → text deltas → runCompleted.
fn prompt_reply_script(
    text: &str,
    prompt_id: Option<&str>,
    images: &[ImageContent],
) -> Vec<ScriptStep> {
    // Stable branch handles for this turn, derived from the user message id so the
    // turn-final assistant offers "branch from here" and the prompt offers "branch
    // from this prompt" — mirroring the real daemon. (See TS promptReply.)
    let u_id = prompt_id
        .map(|p| p.to_string())
        .unwrap_or_else(|| format!("u-{}", ts()));
    let call_id = format!("t-{}", ts());

    // Echo the user's images into the transcript userMessage (so the client renders
    // them as `att-img`/`sent-image`), mirroring TS `promptReply` (fixtures.ts:486).
    let user_images = if images.is_empty() {
        None
    } else {
        Some(images.to_vec())
    };
    // Deterministic resolution feedback: scan the sent text for `@`-tokens the mock
    // recognizes, mirroring the daemon's PromptAccepted.resolved_references.
    let references = {
        let refs = parse_at_references(text);
        (!refs.is_empty()).then_some(refs)
    };

    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: base(),
                id: u_id.clone(),
                text: text.into(),
                images: user_images,
                entry_id: Some(format!("e-{u_id}")),
                references,
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionUpdated {
                base: base(),
                snapshot: mock_snapshot(SessionStatus::Running),
            },
        },
    ];

    // Thinking deltas (rendered under a "Thought process" collapsed block).
    for chunk in deltas("Let me think about the cleanest way to do that.", 3) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Thinking),
                entry_id: None,
            },
        });
    }

    // Text deltas — the visible narration.
    for chunk in deltas(
        "Good question. Here's the plan: I'll start by checking the existing structure, then make the change incrementally so each step is verifiable.",
        3,
    ) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    // Read tool span — ~1.2s (a file read that touches disk).
    steps.extend(tool_span(
        &call_id,
        "read",
        "Read file",
        Some("Read a file from the workspace"),
        serde_json::json!({"path": "server/src/index.ts"}),
        true,
        serde_json::json!("// 42 lines — Bun.serve with WS + /debug/state"),
        140,
        260,
        1200,
    ));

    // Second tool span — a grep for related patterns (keeps the default visual
    // baseline showing a collapsed "Worked for Ns" block under the ≥2 threshold).
    let call_id_2 = format!("t2-{}", ts());
    steps.extend(tool_span(
        &call_id_2,
        "grep",
        "Search",
        Some("Search for a pattern in files"),
        serde_json::json!({"pattern": "app.get", "path": "server/src"}),
        true,
        serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)"),
        80,
        180,
        800,
    ));

    // Final text deltas.
    for chunk in deltas(
        "That confirms it. Making the change now and then I'll verify it builds.",
        3,
    ) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    steps.push(ScriptStep {
        wait_ms: 80,
        event: SessionDriverEvent::RunCompleted {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
            user_entry_id: Some(format!("e-{u_id}")),
            assistant_entry_id: Some(format!("e-a-{u_id}")),
        },
    });

    steps
}

/// The synthetic sidebar row prepended for a freshly-created session — faithful
/// port of TS `NEW_SESSION_ENTRY` (fixtures.ts), spread with the resolved cwd +
/// a cwd-derived session id by `new_session`. Empty preview/count, not archived.
/// Timestamps are `isoAgo(0)` — a
/// REAL RFC3339 now (NOT the mock clock's `ts()`): the client sorts rows by
/// `updatedAt` lexicographically, and `ts()` returns a zero-padded 10-digit mock
/// string (e.g. "0000037045") that sorts BEFORE the fixture rows' real ISO
/// timestamps, dropping the just-created (newest) row to the bottom of the
/// group instead of the top.
fn new_session_entry(session_id: &str, cwd: &str) -> SessionListEntry {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    SessionListEntry {
        session_id: session_id.into(),
        path: NEW_SESSION_PATH.into(),
        cwd: cwd.into(),
        display_name: Some(NEW_SESSION_TITLE.into()),
        preview: String::new(),
        user_message_count: 0,
        updated_at: now.clone(),
        created_at: now.clone(),
        last_user_message_at: now,
        parent_session_path: None,
        usage: None,
        archived: false,
    }
}

/// Seed events for a freshly created (empty) session — faithful port of TS
/// `newSessionSeed`. `dir`/`config` are the ALREADY-RESOLVED cwd + config — the
/// `new_session` driver method derives them (chosen model's
/// thinking levels) the way TS `newSession()` does before calling `newSessionSeed`.
/// Returns the seed events + the sessionOpened snapshot (so the caller can
/// remember it for the deferred first-prompt flow).
fn new_session_seed(
    dir: &str,
    config: SessionConfig,
    facet: Option<String>,
    permission_monitor: PermissionMonitorMode,
) -> (Vec<SessionDriverEvent>, SessionSnapshot) {
    let ref_id = session_ref_for("new-session");
    let workspace = if dir == WORKSPACE_PATH {
        mock_workspace()
    } else {
        WorkspaceRef {
            workspace_id: dir.into(),
            path: dir.into(),
            display_name: Some(
                dir.trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or(dir)
                    .to_string(),
            ),
        }
    };
    let snapshot = SessionSnapshot {
        r#ref: ref_id.clone(),
        workspace,
        title: "New session".into(),
        status: SessionStatus::Idle,
        updated_at: ts(),
        archived_at: None,
        preview: None,
        config: Some(config),
        usage: None,
        running_run_id: None,
        queued_messages: None,
        facet,
        permission_monitor: Some(permission_monitor),
        adventurous_handoff: None,
        notification_autodrain: None,
        active_plan: None,
        goal: None,
        flags: None,
        todos: None,
        mcp_servers: None,
        cwd: None,
        cwd_stack_depth: None,
    };
    let events = vec![SessionDriverEvent::SessionOpened {
        base: SessionEventBase {
            session_ref: ref_id,
            timestamp: ts(),
            run_id: None,
            subagent_handle: None,
        },
        snapshot: snapshot.clone(),
    }];
    (events, snapshot)
}

/// The first turn of a freshly created session, streamed under that session's OWN
/// ref — faithful port of TS `newSessionReply`. The deferred-creation flow
/// delivers the first prompt only after the new session is focused, so its turn
/// must land in the new session's transcript. Streams "On it — the session's up."
fn new_session_reply(
    template: &SessionSnapshot,
    user_text: &str,
    user_id: &str,
    images: &[ImageContent],
) -> Vec<ScriptStep> {
    let ref_id = template.r#ref.clone();
    let b = || SessionEventBase {
        session_ref: ref_id.clone(),
        timestamp: ts(),
        run_id: None,
        subagent_handle: None,
    };
    let snap = |status: SessionStatus| SessionSnapshot {
        status,
        updated_at: ts(),
        ..template.clone()
    };
    let reply = "On it — the session's up. Let me take a first look at what you asked for.";
    let references = {
        let refs = parse_at_references(user_text);
        (!refs.is_empty()).then_some(refs)
    };
    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: b(),
                id: user_id.into(),
                text: user_text.into(),
                images: if images.is_empty() {
                    None
                } else {
                    Some(images.to_vec())
                },
                entry_id: Some(format!("e-{user_id}")),
                references,
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionUpdated {
                base: b(),
                snapshot: snap(SessionStatus::Running),
            },
        },
    ];
    // Stream the reply in ~3-word chunks (same cadence as deltas, inlined so the
    // events carry the new session's ref instead of base()'s demo ref).
    for chunk in deltas(reply, 3) {
        steps.push(ScriptStep {
            wait_ms: 32,
            event: SessionDriverEvent::AssistantDelta {
                base: b(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }
    steps.push(ScriptStep {
        wait_ms: 80,
        event: SessionDriverEvent::RunCompleted {
            base: b(),
            snapshot: snap(SessionStatus::Idle),
            user_entry_id: Some(format!("e-{user_id}")),
            assistant_entry_id: Some(format!("e-a-{user_id}")),
        },
    });
    steps
}

// ── MockDriver ─────────────────────────────────────────────────────────

type ListenerList = Arc<Mutex<Vec<(usize, mpsc::Sender<SessionDriverEvent>)>>>;

pub struct MockDriver {
    listeners: ListenerList,
    next_id: Mutex<usize>,
    /// Generation counter — bumped on reset(). play_script captures the current
    /// generation and aborts if it changes (cancel pending events on reset).
    generation: Arc<AtomicU64>,
    /// The most recently created session's id + seed snapshot, so the FIRST prompt
    /// that follows (the deferred-creation first turn) streams under that session's
    /// own ref instead of the demo session's. Consumed (cleared) by that first prompt.
    /// Mirrors the TS MockDriver's `lastCreated`.
    last_created: Mutex<Option<LastCreated>>,
    /// One-shot: when set, the next `new_session()` returns no seed events then clears
    /// (armed via `run_script("failnewsession")`). Mirrors TS `failNextNewSession`.
    fail_next_new_session: Arc<AtomicBool>,
    /// One-shot openSession() 409 lease-conflict injector (armed via
    /// `run_script("failsession")`). Mirrors TS `failNextSession`. The next
    /// `open_session` throws the lease-conflict message (matching the real
    /// claimLease 409 pattern so `classifySwitchError` + the client's
    /// lease-conflict detection both fire), then the flag clears so a Retry
    /// succeeds.
    fail_next_session: Arc<AtomicBool>,
    /// One-shot artificial delay before abort settles. Dev/e2e-only: exercises the
    /// client-side stop confirmation deadline without weakening normal mock aborts.
    abort_delay_ms: AtomicU64,
    /// One-shot delay (ms) before `new_session` returns its seed events. Dev/e2e-only:
    /// widens the client's warm-up window so e2e can assert the composer badges hold
    /// the draft's values (not daemon defaults) while the seed is pending. Mirrors
    /// `abort_delay_ms`.
    new_session_seed_delay_ms: AtomicU64,
    /// One-shot delay before the terminal `RunCompleted` event fires after an
    /// accepted abort. When set, `abort()` returns `Ok(())` immediately (so
    /// `AbortResult { accepted: true }` is sent quickly) but defers the
    /// `RunCompleted` emit by this many ms. Mirrors the real daemon during a
    /// tool call: accepts the cancel (202) fast, but takes time to interrupt
    /// the running tool and emit the terminal event. Dev/e2e-only.
    abort_settle_delay_ms: AtomicU64,
    /// Pending host-UI dialogs (keyed by requestId), so respondUi can look up the
    /// original request (e.g. a Q&A's questions) when forming the tool result.
    /// Mirrors the TS MockDriver's `pendingDialogs`.
    pending_dialogs: Arc<Mutex<std::collections::HashMap<String, PendingDialog>>>,
    /// Number of responses observed since reset, used by plan-handoff fixtures to
    /// expose deterministic wire-like response summaries to browser tests.
    response_count: Arc<AtomicU64>,
    /// The adventurous-handoff flag, toggled by `toggle_adventurous_handoff`.
    /// Mirrors the TS MockDriver's `adventurousHandoff` private field.
    adventurous_handoff: Arc<std::sync::Mutex<bool>>,
    /// The current goal, mutated by `goal_set`/`pause`/`resume`/`clear` so the
    /// mock reflects state transitions across sequential actions.
    /// `None` = no goal set; `Some(GoalInfo)` = active or paused goal.
    goal: Arc<std::sync::Mutex<Option<GoalInfo>>>,
    /// In-flight script flush handle. When `play_script` starts a new script, it
    /// flushes any previous one first — mirroring TS `play()` → `flushScheduled()`,
    /// which fires all pending steps immediately (cancelling timers) so two scripts
    /// never interleave. The spawned task parks on `flush_rx` between steps; a flush
    /// closes the channel, which makes `flush_rx.try_recv()` return `Err(Closed)`,
    /// signalling the task to drain its remaining steps with zero delay.
    in_flight: Arc<Mutex<Option<InFlightHandle>>>,
    /// Monotonic per-script id, so a spawned task can compare-and-clear `in_flight`
    /// only for its own handle (TOCTOU: an old task finishing concurrently with a
    /// new `play_script` must not null out the newer handle).
    next_script_id: AtomicU64,
    /// Number of `play_script` invocations since the last reset. Runs after the
    /// first get their dialog request ids suffixed (`-run{N}`) so a second drive
    /// of the same fixture (e.g. `planhandoff`) cannot emit notice ids that
    /// duplicate the first drive's (the client derives transcript notice ids
    /// `resolved-{requestId}`/`response-summary-{requestId}` from them, and the
    /// keyed transcript drops items with duplicate ids).
    script_run: AtomicU64,
    /// Mutable session list — `mock_session_list()` at construction + reset, with a
    /// synthetic "new" row PREPENDED by `new_session` (mirrors TS `this.sessions`).
    /// `list_sessions` returns this. The TS
    /// mock served this mutable list so a freshly-created session appears in the
    /// sidebar immediately; the Rust mock previously returned the static list and a
    /// new session never showed up.
    sessions: Arc<Mutex<Vec<SessionListEntry>>>,
    /// Per-session queued input overlay. Mirrors TS MockDriver.queues: queueUpdated
    /// events replace the client queue, and openSession overlays queuedMessages on
    /// seed snapshots so reconnect/session refocus preserve queued rows.
    queues: Arc<Mutex<HashMap<SessionId, Vec<SessionQueuedMessage>>>>,
    /// The mock's current model selection, mutated by set_model/set_thinking so
    /// the picker reflects config changes. Mirrors TS MockDriver.config.
    config: Arc<Mutex<SessionConfig>>,
    /// Mutable fixture jobs for the jobs sidebar section. Seeded with default
    /// fixtures; `run_script("jobs")` can swap them for e2e testing.
    jobs: Arc<Mutex<Vec<BackgroundJob>>>,
    /// Mutable fixture todos for the todo delete path. Seeded from the `context`
    /// script's snapshot; `delete_todo` removes from here.
    todos: Arc<Mutex<Vec<TodoItem>>>,
    /// Test-controllable set of "warm" session IDs. The mock has no real daemon,
    /// so `has_warm_session` checks this set instead. Empty by default (matching
    /// the trait default of `false`); tests insert session IDs to simulate warm
    /// daemon attachments for journal-eviction testing.
    warm_sessions: Arc<Mutex<std::collections::HashSet<SessionId>>>,
    accepted_prompts: Arc<Mutex<std::collections::HashSet<SessionId>>>,
    live_config_actions: Arc<Mutex<std::collections::HashSet<SessionId>>>,
    empty_default: Arc<Mutex<std::collections::HashSet<SessionId>>>,
}

/// Handle to a currently-running script, so the next `play_script` can flush it.
struct InFlightHandle {
    /// Per-script id, so the spawned task can compare-and-clear `in_flight` only
    /// when it still holds THIS handle (prevents a late-exiting old task from
    /// nulling out a newer script's handle — TOCTOU).
    script_id: u64,
    /// Remaining steps the spawned task hasn't fired yet. The task PEEKS the front
    /// step while sleeping and only `pop_front()`s it immediately before firing —
    /// so a flush arriving mid-sleep can still drain (and fire) that step. Mirrors
    /// TS `play()`, where a timer splices its entry out of `scheduled` only inside
    /// its own callback, immediately before `fireStep`; `flushScheduled` fires ALL
    /// still-pending entries in order. The pop+fire happens UNDER this lock so the
    /// flusher's drain can't interleave between them (ordering — see play_script).
    remaining: Arc<Mutex<VecDeque<ScriptStep>>>,
    /// Set by the flusher once it has drained + fired `remaining`. The task checks
    /// this after waking from sleep, before pop+fire, so it never double-fires a
    /// step the flusher already emitted.
    drained: Arc<AtomicBool>,
    /// Closed by the flusher to signal the spawned task to stop sleeping.
    flush_tx: oneshot::Sender<()>,
}

/// The ref + snapshot of a just-created session, consumed by the first prompt.
struct LastCreated {
    session_id: SessionId,
    snapshot: SessionSnapshot,
}

/// A pending host-UI dialog, tracked so respondUi can look up the original
/// request (e.g. a Q&A's questions) when forming the answer tool result.
struct PendingDialog {
    request: HostUiRequest,
    session_ref: SessionRef,
}

impl MockDriver {
    pub fn new() -> Self {
        Self {
            listeners: Arc::new(Mutex::new(Vec::new())),
            next_id: Mutex::new(0),
            generation: Arc::new(AtomicU64::new(0)),
            last_created: Mutex::new(None),
            fail_next_new_session: Arc::new(AtomicBool::new(false)),
            fail_next_session: Arc::new(AtomicBool::new(false)),
            abort_delay_ms: AtomicU64::new(0),
            new_session_seed_delay_ms: AtomicU64::new(0),
            abort_settle_delay_ms: AtomicU64::new(0),
            pending_dialogs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            response_count: Arc::new(AtomicU64::new(0)),
            adventurous_handoff: Arc::new(std::sync::Mutex::new(false)),
            goal: Arc::new(std::sync::Mutex::new(None)),
            in_flight: Arc::new(Mutex::new(None)),
            next_script_id: AtomicU64::new(0),
            script_run: AtomicU64::new(0),
            sessions: Arc::new(Mutex::new(mock_session_list())),
            queues: Arc::new(Mutex::new(HashMap::new())),
            config: Arc::new(Mutex::new(mock_default_config())),
            jobs: Arc::new(Mutex::new(mock_default_jobs())),
            todos: Arc::new(Mutex::new(mock_default_todos())),
            warm_sessions: Arc::new(Mutex::new(std::collections::HashSet::new())),
            accepted_prompts: Arc::new(Mutex::new(std::collections::HashSet::new())),
            live_config_actions: Arc::new(Mutex::new(std::collections::HashSet::new())),
            empty_default: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    fn emit(&self, ev: SessionDriverEvent) {
        let listeners = self.listeners.lock();
        for (_, tx) in listeners.iter() {
            let _ = tx.try_send(ev.clone());
        }
    }

    fn emit_queue(&self, session_id: &str) {
        let messages = self
            .queues
            .lock()
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        self.emit(SessionDriverEvent::QueueUpdated {
            base: SessionEventBase {
                session_ref: session_ref_for(session_id),
                timestamp: ts(),
                run_id: None,
                subagent_handle: None,
            },
            messages,
        });
    }

    fn cancel_timers(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        *self.in_flight.lock() = None;
        self.pending_dialogs.lock().clear();
        self.response_count.store(0, Ordering::Relaxed);
    }

    /// Mark a session as "warm" (has a live daemon attachment) for testing
    /// journal-eviction logic. The mock has no real daemon, so this simulates
    /// the warm state that `has_warm_session` checks.
    pub fn add_warm_session(&self, sid: SessionId) {
        self.warm_sessions.lock().insert(sid);
    }

    /// Remove a session from the "warm" set (simulate daemon crash/detach).
    pub fn remove_warm_session(&self, sid: &SessionId) {
        self.warm_sessions.lock().remove(sid);
    }

    fn play_script(&self, steps: Vec<ScriptStep>) {
        // Serialize replays: instantly settle any in-flight script before starting a
        // new one — faithful port of TS `play()` → `flushScheduled()`. Two concurrent
        // timer sequences interleave their assistantDelta events, and foldEvent appends
        // each delta to whichever assistant is currently open — so an overlapping
        // greeting + reply splits one thinking block across two turns and leaks the
        // greeting's tail text into the reply. Flushing keeps the mock's
        // one-turn-at-a-time semantics, matching the real driver.
        self.flush_scheduled();

        // Replays after the first get their dialog request ids rewritten (see
        // rewrite_script_request_ids) so re-driving the same fixture cannot
        // collide with an earlier drive's ids. The first run keeps its stable
        // ids, so single-drive scripts and existing assertions are unaffected.
        let run = self.script_run.fetch_add(1, Ordering::Relaxed);
        let steps = if run == 0 {
            steps
        } else {
            steps
                .into_iter()
                .map(|step| rewrite_script_request_ids(step, run))
                .collect()
        };

        let remaining: Arc<Mutex<VecDeque<ScriptStep>>> =
            Arc::new(Mutex::new(steps.into_iter().collect()));
        let drained = Arc::new(AtomicBool::new(false));
        let (flush_tx, mut flush_rx) = oneshot::channel::<()>();
        let script_id = self.next_script_id.fetch_add(1, Ordering::Relaxed);
        *self.in_flight.lock() = Some(InFlightHandle {
            script_id,
            remaining: remaining.clone(),
            drained: drained.clone(),
            flush_tx,
        });

        let listeners = self.listeners.clone();
        let gen_ctr = self.generation.clone();
        let start_gen = gen_ctr.load(Ordering::Relaxed);
        let pending = self.pending_dialogs.clone();
        let in_flight = self.in_flight.clone();
        tokio::spawn(async move {
            loop {
                // PEEK (don't pop) the front step while we may still sleep on it.
                // TS `play()` keeps every not-yet-fired timer entry in `scheduled`;
                // the timer only splices its entry out inside its own callback,
                // immediately before `fireStep`. We mirror that: the step stays in
                // the deque across the await so a flush can still drain + fire it.
                let wait_ms = {
                    let q = remaining.lock();
                    match q.front() {
                        Some(step) => step.wait_ms,
                        None => break,
                    }
                };
                if wait_ms > 0 {
                    // Race the delay against a flush. On the flush arm we return
                    // WITHOUT popping — the step is still in the deque, so the
                    // flusher's drain(..) picks it up and fires it. (No dropped step.)
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(wait_ms)) => {}
                        _ = &mut flush_rx => { return; }
                    }
                }
                // Abort if reset() was called since we started.
                if gen_ctr.load(Ordering::Relaxed) != start_gen {
                    return;
                }
                // The flusher may have drained + fired `remaining` while we slept
                // (it sets `drained` under the same lock). If so, skip pop+fire to
                // avoid duplicating a step the flusher already emitted. The drained
                // check + pop are atomic under one lock hold, matching the flusher's
                // atomic set-drained + drain — so the two can't interleave.
                //
                // ORDERING: fire_step runs UNDER the `remaining` lock (no `drop(q)`
                // first). Without this, on a multi-threaded runtime a flusher could
                // run in the gap between our pop and our fire: it takes the handle,
                // sets `drained`, drains+fires the LATER queued steps, then we resume
                // and fire this earlier step — emitting later steps before the popped
                // one and violating TS's strict step order (transcript fold order).
                // TS `play()` splices a timer entry out and calls `fireStep` in the
                // SAME synchronous JS callback; `flushScheduled` cannot run between
                // splice and fireStep on the single event loop. Holding the lock here
                // reproduces that atomicity: pop+fire is one critical section, so the
                // flusher's drain (which locks `remaining`) can't observe a popped-
                // but-unfired step — it only ever drains steps AFTER the one we fire.
                // fire_step is non-blocking (try_send + a HashMap insert), so holding
                // the lock across it is cheap and deadlock-free: it takes
                // `pending`→`listeners`, never the inverse, and no path takes
                // `remaining` after either.
                let fired_here = {
                    let mut q = remaining.lock();
                    if drained.load(Ordering::Relaxed) {
                        false
                    } else {
                        match q.pop_front() {
                            Some(step) => {
                                fire_step(&step, &listeners, &pending);
                                true
                            }
                            None => false,
                        }
                    }
                };
                if !fired_here {
                    // Either the queue was drained by the flusher (stop — it owns
                    // the rest) or it emptied naturally (loop will break next iter).
                    if drained.load(Ordering::Relaxed) {
                        return;
                    }
                }
            }
            // Script completed normally — clear the in-flight handle, but ONLY if it
            // still points at THIS task (compare-and-clear). A concurrent
            // `play_script` may have flushed us and installed a newer handle; we must
            // not null that out (TOCTOU).
            {
                let mut h = in_flight.lock();
                if let Some(current) = h.as_ref() {
                    if current.script_id == script_id {
                        *h = None;
                    }
                }
            }
        });
    }

    /// Fire all remaining steps of the in-flight script immediately, in order,
    /// then clear the handle. Mirrors TS `flushScheduled()` — cancelling timers
    /// and emitting each step so a new replay never overlaps the previous one.
    /// Invariant: fires EVERY not-yet-fired step (including the one the task is
    /// currently sleeping on, which stays in the deque), with zero dropped and
    /// zero duplicated (the `drained` flag makes the task skip pop+fire).
    fn flush_scheduled(&self) {
        let handle = { self.in_flight.lock().take() };
        if let Some(handle) = handle {
            // Mark drained BEFORE draining so the task, if it wakes from sleep
            // concurrently, sees `drained` and skips pop+fire (no double-fire).
            // The drain holds `remaining`, serializing against the task's pop+fire
            // (which now also fires UNDER that lock — see play_script). By the time
            // we release the lock the deque is EMPTY, so the task can't pop any of
            // the steps we drained: its next `front()` is None (break) and, even on
            // a racy re-entry, `drained` is set (return). That makes firing the
            // drained steps OUTSIDE the lock safe — we own all of them exclusively,
            // matching TS `flushScheduled`'s single synchronous clear+fire loop.
            let drained_steps: Vec<ScriptStep> = {
                let _ = handle.flush_tx.send(());
                handle.drained.store(true, Ordering::Relaxed);
                handle.remaining.lock().drain(..).collect()
            };
            let listeners = self.listeners.clone();
            let pending = self.pending_dialogs.clone();
            for step in drained_steps {
                fire_step(&step, &listeners, &pending);
            }
        }
    }
}

/// Emit one step's event plus its side bookkeeping. Shared by the timer path and
/// Rewrite the dialog request ids of a script step for a replay run after the
/// first, so re-driving the same fixture (e.g. `planhandoff`) cannot emit ids
/// that duplicate an earlier drive's. The client derives transcript notice ids
/// (`resolved-{requestId}`/`response-summary-{requestId}`) from dialog request
/// ids, and the keyed transcript drops items with duplicate ids — so a second
/// drive's acknowledgement notices silently vanished. Scoped to dialog
/// `HostUiRequest`s and scripted `HostUiResolved` steps: the client echoes the
/// request id back in `respondUi`, so `respond_ui`'s derived notice ids and
/// `fire_step`'s pending-dialog bookkeeping stay consistent automatically.
/// Ambient (status/widget/notify) ids are not involved in the collision and
/// are left alone.
fn rewrite_script_request_ids(step: ScriptStep, run: u64) -> ScriptStep {
    let event = match step.event {
        SessionDriverEvent::HostUiRequest { base, request } if is_dialog_request(&request) => {
            SessionDriverEvent::HostUiRequest {
                base,
                request: rewrite_dialog_request_id(request, run),
            }
        }
        SessionDriverEvent::HostUiResolved { base, request_id } => {
            SessionDriverEvent::HostUiResolved {
                base,
                request_id: format!("{request_id}-run{run}"),
            }
        }
        other => other,
    };
    ScriptStep {
        wait_ms: step.wait_ms,
        event,
    }
}

fn rewrite_dialog_request_id(request: HostUiRequest, run: u64) -> HostUiRequest {
    let suffix = format!("-run{run}");
    let rewrite = |id: String| format!("{id}{suffix}");
    use HostUiRequest as H;
    match request {
        H::Confirm {
            request_id,
            title,
            message,
            default_value,
            timeout_ms,
        } => H::Confirm {
            request_id: rewrite(request_id),
            title,
            message,
            default_value,
            timeout_ms,
        },
        H::Unknown {
            request_id,
            title,
            message,
        } => H::Unknown {
            request_id: rewrite(request_id),
            title,
            message,
        },
        H::Input {
            request_id,
            title,
            placeholder,
            initial_value,
            timeout_ms,
        } => H::Input {
            request_id: rewrite(request_id),
            title,
            placeholder,
            initial_value,
            timeout_ms,
        },
        H::Select {
            request_id,
            title,
            options,
            allow_multiple,
            timeout_ms,
        } => H::Select {
            request_id: rewrite(request_id),
            title,
            options,
            allow_multiple,
            timeout_ms,
        },
        H::Editor {
            request_id,
            title,
            initial_value,
        } => H::Editor {
            request_id: rewrite(request_id),
            title,
            initial_value,
        },
        H::Qna {
            request_id,
            title,
            questions,
            timeout_ms,
        } => H::Qna {
            request_id: rewrite(request_id),
            title,
            questions,
            timeout_ms,
        },
        H::Plan {
            request_id,
            title,
            plan_text,
            display_path,
            target_facet,
            action_labels,
            refuse_label,
            timeout_ms,
        } => H::Plan {
            request_id: rewrite(request_id),
            title,
            plan_text,
            display_path,
            target_facet,
            action_labels,
            refuse_label,
            timeout_ms,
        },
        H::Permission {
            request_id,
            title,
            tool_name,
            tool_input,
            options,
            timeout_ms,
        } => H::Permission {
            request_id: rewrite(request_id),
            title,
            tool_name,
            tool_input,
            options,
            timeout_ms,
        },
        other => other,
    }
}

/// `flush_scheduled` so a flushed event behaves exactly like a fired one — faithful
/// port of TS `fireStep()`.
fn fire_step(
    step: &ScriptStep,
    listeners: &ListenerList,
    pending: &Arc<Mutex<std::collections::HashMap<String, PendingDialog>>>,
) {
    // Track dialog requests so respondUi can look them up later
    // (mirrors TS fireStep's pendingDialogs.set for hostUiRequest). A scripted
    // HostUiResolved also clears bookkeeping, which lets the pending fixture
    // model remote resolution before a replacement request arrives.
    match &step.event {
        SessionDriverEvent::HostUiRequest { base, request } if is_dialog_request(request) => {
            pending.lock().insert(
                request_id_of(request).to_string(),
                PendingDialog {
                    request: request.clone(),
                    session_ref: base.session_ref.clone(),
                },
            );
        }
        SessionDriverEvent::HostUiResolved { request_id, .. } => {
            pending.lock().remove(request_id);
        }
        _ => {}
    }
    let listeners = listeners.lock();
    for (_, tx) in listeners.iter() {
        let _ = tx.try_send(step.event.clone());
    }
}

fn prompt_map_long_script() -> Vec<ScriptStep> {
    let user_id = "u-promptmap-long";
    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: base(),
                id: user_id.into(),
                text: "Show a long response so the prompt map can track the whole turn.".into(),
                images: None,
                entry_id: Some(format!("e-{user_id}")),
                references: None,
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionUpdated {
                base: base(),
                snapshot: mock_snapshot(SessionStatus::Running),
            },
        },
    ];
    let response = (1..=26)
        .map(|i| format!("Paragraph {i}: This deliberately long assistant response keeps the turn visible while its prompt scrolls away.",))
        .collect::<Vec<_>>()
        .join("\n\n");
    for chunk in deltas(&response, 4) {
        steps.push(ScriptStep {
            wait_ms: 12,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }
    steps.push(ScriptStep {
        wait_ms: 40,
        event: SessionDriverEvent::RunCompleted {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
            user_entry_id: Some(format!("e-{user_id}")),
            assistant_entry_id: Some(format!("e-a-{user_id}")),
        },
    });
    steps
}

fn prompt_map_hold_script() -> Vec<ScriptStep> {
    let user_id = "u-promptmap-hold";
    vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: base(),
                id: user_id.into(),
                text: "Pause this prompt while the response is still in progress.".into(),
                images: None,
                entry_id: Some(format!("e-{user_id}")),
                references: None,
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionUpdated {
                base: base(),
                snapshot: mock_snapshot(SessionStatus::Running),
            },
        },
    ]
}

fn prompt_map_tool_only_script() -> Vec<ScriptStep> {
    let user_id = "u-promptmap-tool-only";
    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: base(),
                id: user_id.into(),
                text: "Run a tool without producing a final response.".into(),
                images: None,
                entry_id: Some(format!("e-{user_id}")),
                references: None,
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionUpdated {
                base: base(),
                snapshot: mock_snapshot(SessionStatus::Running),
            },
        },
    ];
    steps.extend(tool_span(
        "promptmap-tool-only",
        "read",
        "Read file",
        Some("Read a fixture file"),
        serde_json::json!({"path": "README.md"}),
        true,
        serde_json::json!("fixture contents"),
        20,
        20,
        120,
    ));
    steps.push(ScriptStep {
        wait_ms: 20,
        event: SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
        },
    });
    steps
}

impl Default for MockDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PantokenDriver for MockDriver {
    fn subscribe(&self, listener: Box<dyn Fn(SessionDriverEvent) + Send + Sync>) -> usize {
        let id = {
            let mut next = self.next_id.lock();
            let id = *next;
            *next += 1;
            id
        };
        let (tx, mut rx) = mpsc::channel(256);
        self.listeners.lock().push((id, tx));
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                listener(ev);
            }
        });
        id
    }

    fn unsubscribe(&self, id: usize) {
        self.listeners.lock().retain(|(sid, _)| *sid != id);
    }

    async fn prompt(
        &self,
        text: String,
        _deliver_as: Option<DeliveryMode>,
        session_id: Option<SessionId>,
        images: Vec<ImageContent>,
        prompt_id: Option<String>,
    ) -> Result<(), String> {
        // Faithful port of TS `MockDriver.prompt()` (`server/src/mock-driver.ts:381`):
        // the `__pantoken_reject_prompt__` sentinel rejects (surfaces as a
        // `promptResult { accepted: false }` so the client shows "Not sent — …"),
        // then the deferred-creation first turn + normal demo-session reply.
        if text == "__pantoken_reject_prompt__" {
            return Err("Mock prompt rejected before acceptance".into());
        }
        // Deferred-creation first turn: this prompt targets the session we JUST
        // created, so stream it under that session's own ref (not the demo
        // session's) and consume the one-shot marker. Subsequent prompts fall
        // through to the normal demo-session reply. (Mirrors TS prompt().)
        let pid = prompt_id.clone().unwrap_or_else(|| format!("u-{}", ts()));
        let lifecycle_session_id = session_id.clone();
        if let Some(session_id) = session_id {
            let taken = {
                let mut lc = self.last_created.lock();
                if lc
                    .as_ref()
                    .map(|c| c.session_id == session_id)
                    .unwrap_or(false)
                {
                    lc.take()
                } else {
                    None
                }
            };
            if let Some(created) = taken {
                let steps = new_session_reply(&created.snapshot, &text, &pid, &images);
                self.accepted_prompts.lock().insert(session_id);
                self.play_script(steps);
                return Ok(());
            }
        }
        if let Some(sid) = lifecycle_session_id {
            self.accepted_prompts.lock().insert(sid);
        }
        let steps = prompt_reply_script(&text, Some(&pid), &images);
        self.play_script(steps);
        Ok(())
    }

    async fn abort(&self, _session_id: Option<SessionId>) -> Result<(), String> {
        // Faithful port of TS `MockDriver.abort()` (`server/src/mock-driver.ts:411`):
        // clear pending scheduled events FIRST (so a `pendinghold` thinking-delta
        // timer can't fire after abort and re-open the turn), then settle any open
        // tool the aborted turn left running (the real driver emits a
        // tool_execution_end on abort), then emit runCompleted to end the turn.
        // Without cancel_timers the Stop pill never clears — a scheduled delta
        // fires after the abort's runCompleted and the turn re-activates.
        let delay_ms = self.abort_delay_ms.swap(0, Ordering::SeqCst);
        if delay_ms > 0 {
            // Capture the generation before the delay and re-check after it: the
            // slowabort path can outlive its own test (the delayed abort settles
            // after the test's assertions already passed), and a late
            // cancel_timers would land in the NEXT test and kill its in-flight
            // script. Same generation guard as the settle path below.
            let start_gen = self.generation.load(Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            if self.generation.load(Ordering::Relaxed) != start_gen {
                return Ok(());
            }
        }
        self.cancel_timers();

        let settle_delay_ms = self.abort_settle_delay_ms.swap(0, Ordering::SeqCst);
        if settle_delay_ms > 0 {
            // Return Ok immediately so AbortResult { accepted: true } is sent.
            // Delay the terminal RunCompleted event to simulate a tool call
            // that takes time to interrupt — mirrors the real daemon's behavior:
            // accepts the cancel (202) quickly but needs time to settle.
            let listeners = self.listeners.clone();
            let generation = self.generation.clone();
            let start_gen = generation.load(Ordering::Relaxed);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(settle_delay_ms)).await;
                // Abort if reset() was called since we started — same generation
                // guard as play_script, so a stale RunCompleted can't land on a
                // fresh test's listeners.
                if generation.load(Ordering::Relaxed) != start_gen {
                    return;
                }
                let b = base();
                let listeners = listeners.lock();
                for (_, tx) in listeners.iter() {
                    let _ = tx.try_send(SessionDriverEvent::RunCompleted {
                        base: b.clone(),
                        snapshot: mock_snapshot(SessionStatus::Idle),
                        user_entry_id: None,
                        assistant_entry_id: None,
                    });
                }
            });
            return Ok(());
        }

        let b = base();
        self.emit(SessionDriverEvent::RunCompleted {
            base: b,
            snapshot: mock_snapshot(SessionStatus::Idle),
            user_entry_id: None,
            assistant_entry_id: None,
        });
        Ok(())
    }

    async fn clear_queue(
        &self,
        session_id: Option<SessionId>,
    ) -> Result<ClearQueueResult, DriverError> {
        let sid = session_id.unwrap_or_else(|| SESSION_ID.into());
        let queued = {
            let mut queues = self.queues.lock();
            let queued = queues.get(&sid).cloned().unwrap_or_default();
            queues.insert(sid.clone(), Vec::new());
            queued
        };
        self.emit_queue(&sid);
        Ok(ClearQueueResult {
            steering: queued
                .iter()
                .filter(|message| message.mode == SessionMessageDeliveryMode::Steer)
                .map(|message| message.text.clone())
                .collect(),
            follow_up: queued
                .iter()
                .filter(|message| message.mode == SessionMessageDeliveryMode::FollowUp)
                .map(|message| message.text.clone())
                .collect(),
        })
    }

    fn respond_ui(&self, response: HostUiResponse, _session_id: Option<SessionId>) {
        let request_id = match &response {
            HostUiResponse::Value { request_id, .. } => request_id.clone(),
            HostUiResponse::Confirmed { request_id, .. } => request_id.clone(),
            HostUiResponse::Answers { request_id, .. } => request_id.clone(),
            HostUiResponse::Cancelled { request_id, .. } => request_id.clone(),
        };
        // Look up the pending dialog (mirrors TS pendingDialogs.get/delete) so we
        // can recover the Q&A questions for the answer tool's input + formatted text.
        let pending = self.pending_dialogs.lock().remove(&request_id);
        let session_ref = pending
            .as_ref()
            .map(|d| d.session_ref.clone())
            .unwrap_or_else(mock_session_ref);
        // Emit HostUiResolved to clear the dialog.
        self.emit(SessionDriverEvent::HostUiResolved {
            base: base_with_ref(session_ref.clone()),
            request_id: request_id.clone(),
        });

        let response_number = self.response_count.fetch_add(1, Ordering::Relaxed) + 1;
        match &response {
            HostUiResponse::Answers { answers, .. } => {
                // Q&A: mirror the real driver, where the `answer` tool records the
                // filled-in Q&A as its result. Emit a toolStarted/toolFinished pair
                // (not a notify) so the client's tool-result render path is exercised.
                let questions: Vec<QnaQuestion> = match &pending {
                    Some(d) => match &d.request {
                        HostUiRequest::Qna { questions, .. } => questions.clone(),
                        _ => Vec::new(),
                    },
                    None => Vec::new(),
                };
                let text = format_qna_text(&questions, answers);
                let call_id = format!("answer-{request_id}");
                self.emit(SessionDriverEvent::ToolStarted {
                    base: base_with_ref(session_ref.clone()),
                    call_id: call_id.clone(),
                    tool_name: "answer".into(),
                    label: Some("Answer".into()),
                    description: None,
                    input: Some(serde_json::json!({ "questions": questions })),
                });
                self.emit(SessionDriverEvent::ToolFinished {
                    base: base_with_ref(session_ref.clone()),
                    call_id,
                    success: true,
                    output: Some(serde_json::json!({
                        "content": [{ "type": "text", "text": text }]
                    })),
                    images: None,
                    interrupted: None,
                });
            }
            _ => {
                // Confirm/input/cancelled: emit a notify with the summary message.
                // Plan refusals use the same UI response endpoint but carry an
                // explicit feedback marker, including Some("") for an intentional
                // empty explanation. Keep the wire-like summary separate from the
                // human notice so E2E can assert the exact cancellation shape.
                let (summary, wire_summary) = match &response {
                    HostUiResponse::Cancelled { .. } => (
                        "Dialog cancelled.".to_string(),
                        serde_json::json!({
                            "requestId": request_id.clone(),
                            "cancelled": true,
                            "responseCount": response_number,
                        }),
                    ),
                    HostUiResponse::Confirmed { confirmed, .. } => {
                        let summary = if *confirmed {
                            "Approved — continuing."
                        } else {
                            "Denied — skipping that step."
                        };
                        (
                            summary.to_string(),
                            serde_json::json!({
                                "requestId": request_id.clone(),
                                "confirmed": confirmed,
                                "responseCount": response_number,
                            }),
                        )
                    }
                    HostUiResponse::Value {
                        value, feedback, ..
                    } => {
                        let is_plan = pending
                            .as_ref()
                            .is_some_and(|d| matches!(&d.request, HostUiRequest::Plan { .. }));
                        if is_plan {
                            if let Some(feedback) = feedback {
                                let supplied = !feedback.is_empty();
                                (
                                    format!(
                                        "Plan refusal submitted{}.",
                                        if supplied {
                                            " with feedback"
                                        } else {
                                            " without feedback"
                                        }
                                    ),
                                    serde_json::json!({
                                        "requestId": request_id.clone(),
                                        "value": value,
                                        "decision": { "refuse": { "feedback": feedback } },
                                        "responseCount": response_number,
                                    }),
                                )
                            } else {
                                (
                                    format!("Received: {value}"),
                                    serde_json::json!({
                                        "requestId": request_id.clone(),
                                        "value": value,
                                        "responseCount": response_number,
                                    }),
                                )
                            }
                        } else {
                            (
                                format!("Received: {value}"),
                                serde_json::json!({
                                    "requestId": request_id.clone(),
                                    "value": value,
                                    "responseCount": response_number,
                                }),
                            )
                        }
                    }
                    HostUiResponse::Answers { .. } => unreachable!(),
                };
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base_with_ref(session_ref.clone()),
                    request: HostUiRequest::Notify {
                        request_id: format!("resolved-{request_id}"),
                        message: summary,
                        level: Some(NotifyLevel::Info),
                    },
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base_with_ref(session_ref),
                    request: HostUiRequest::Notify {
                        request_id: format!("response-summary-{request_id}"),
                        message: format!("respondUi: {}", wire_summary),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
        }
    }

    async fn list_sessions(&self) -> Vec<SessionListEntry> {
        // Clone the mutable `sessions` list. Rows `new_session` created prepend a synthetic "new" row.
        self.sessions.lock().clone()
    }

    async fn destroy_session(&self, path: String) -> Result<(), DriverError> {
        let mut sessions = self.sessions.lock();
        let Some(index) = sessions.iter().position(|entry| entry.path == path) else {
            return Ok(());
        };
        let entry = sessions[index].clone();
        if !self.empty_default.lock().contains(&entry.session_id)
            || self.accepted_prompts.lock().contains(&entry.session_id)
            || self.live_config_actions.lock().contains(&entry.session_id)
        {
            return Err(DriverError::operation_failed(
                "destroy_session",
                "session is populated or configured",
            ));
        }
        sessions.remove(index);
        drop(sessions);
        self.warm_sessions.lock().remove(&entry.session_id);
        self.queues.lock().remove(&entry.session_id);
        self.accepted_prompts.lock().remove(&entry.session_id);
        self.live_config_actions.lock().remove(&entry.session_id);
        self.empty_default.lock().remove(&entry.session_id);
        if self
            .last_created
            .lock()
            .as_ref()
            .map(|created| created.session_id == entry.session_id)
            .unwrap_or(false)
        {
            self.last_created.lock().take();
        }
        self.pending_dialogs.lock().retain(|_, dialog| {
            dialog.session_ref.session_id.as_str() != entry.session_id.as_str()
        });
        self.cancel_timers();
        Ok(())
    }

    async fn open_session(
        &self,
        path: String,
    ) -> Result<Vec<SessionDriverEvent>, SessionSwitchError> {
        if !self.sessions.lock().iter().any(|entry| entry.path == path) {
            return Err(SessionSwitchError::MissingSessionPath {
                path,
                detail: "unknown mock session path".into(),
            });
        }
        // One-shot failure injection (armed via run_script("failsession")):
        // throw a 409 lease-conflict error before any state mutation, mirroring
        // a real claimLease 409 when the TUI holds the lease. The message matches
        // the real claimLease pattern so classifySwitchError + the client's
        // lease-conflict detection both fire. The one-shot flag clears on the
        // first attempt, so a Retry → second openSession succeeds. (Faithful port
        // of TS `MockDriver.openSession`, mock-driver.ts:614-619.)
        if self.fail_next_session.swap(false, Ordering::SeqCst) {
            return Err(SessionSwitchError::LeaseConflict {
                holder: Some(LeaseHolder {
                    summary: "\"tui\" pid 99999".into(),
                    expires_at: None,
                }),
                detail: "another TUI is attached to this session (\"tui\" pid 99999, lease expires in 30s). Detach it there (/detach) or wait 30s for its lease to lapse.".into(),
            });
        }
        // Faithful port of TS MockDriver.openSession(): the base seed, then any
        // pending host-UI dialogs for this session appended to the end so opening
        // a background session blocked on an approval replays that dialog.
        let mut seed = mock_session_seed(&path);
        let session_id = seed.first().map(|e| e.session_ref().session_id.clone());
        if let Some(sid) = session_id {
            let queued = self.queues.lock().get(&sid).cloned().unwrap_or_default();
            for event in &mut seed {
                match event {
                    SessionDriverEvent::SessionOpened { snapshot, .. }
                    | SessionDriverEvent::SessionUpdated { snapshot, .. }
                    | SessionDriverEvent::RunCompleted { snapshot, .. } => {
                        snapshot.queued_messages = Some(queued.clone());
                    }
                    _ => {}
                }
            }

            let pending = self.pending_dialogs.lock();
            for p in pending.values() {
                if p.session_ref.session_id == sid {
                    seed.push(SessionDriverEvent::HostUiRequest {
                        base: SessionEventBase {
                            session_ref: p.session_ref.clone(),
                            timestamp: ts(),
                            run_id: None,
                            subagent_handle: None,
                        },
                        request: p.request.clone(),
                    });
                }
            }
        }
        Ok(seed)
    }

    /// Deterministic stand-in for the driver's dispose-and-re-warm. The mock has no
    /// warm AgentSession to throw away, so a reload is just a fresh seed of the same
    /// session — enough to exercise the hub's reseed path and the client wiring.
    /// (Faithful port of TS `MockDriver.reloadSession`, mock-driver.ts:649-651.)
    async fn reload_session(
        &self,
        path: String,
    ) -> Result<Vec<SessionDriverEvent>, SessionSwitchError> {
        self.open_session(path).await
    }

    /// Detach is a successful no-op in the mock: it has no daemon lease or SSE
    /// stream to release, while the hub still exercises its cleanup/broadcast path.
    async fn detach_session(&self, _path: String) -> Result<(), DriverError> {
        Ok(())
    }

    async fn branch_from(
        &self,
        entry_id: String,
        _summarize: bool,
        _session_id: Option<SessionId>,
    ) -> Result<BranchResult, String> {
        self.cancel_timers();
        let is_user = entry_id == "e-u1" || entry_id == "e-u2";
        if is_user {
            return Ok(BranchResult {
                seed: branched_seed(),
                editor_text: Some(if entry_id == "e-u1" {
                    GREETING_PROMPT.into()
                } else {
                    "actually, put it in a separate health-router module".into()
                }),
                cancelled: false,
                aborted: None,
            });
        }
        Ok(BranchResult {
            seed: greeting_seed(),
            editor_text: None,
            cancelled: false,
            aborted: None,
        })
    }

    async fn new_session(
        &self,
        opts: NewSessionOptsData,
    ) -> Result<Vec<SessionDriverEvent>, SessionSwitchError> {
        // One-shot failure injection (armed via run_script("failnewsession")): fail before
        // any state mutation, mirroring TS `MockDriver.failNextNewSession`.
        if self.fail_next_new_session.swap(false, Ordering::SeqCst) {
            return Err(SessionSwitchError::unexpected(
                "new_session",
                "new session failed (failnewsession)",
            ));
        }
        // One-shot artificial delay (armed via run_script("slownewsession")): widen
        // the client's warm-up window so e2e can assert the composer badges hold the
        // draft's values (not daemon defaults) while the seed is pending.
        let seed_delay = self.new_session_seed_delay_ms.swap(0, Ordering::SeqCst);
        if seed_delay > 0 {
            tokio::time::sleep(Duration::from_millis(seed_delay)).await;
        }
        // Faithful port of TS `newSession()`: resolve the cwd and build a config
        // carrying the chosen model's availableThinkingLevels + the draft's (or
        // default) thinking level, then hand the resolved dir + config to
        // `newSessionSeed`. Remember the snapshot so the first prompt streams
        // under this session's own ref — mirrors the real driver's apply-on-create.
        // Prepends a synthetic "new" row to the mutable session list (so the new
        // session appears in the sidebar immediately) — faithful to TS.
        let NewSessionOptsData {
            cwd,
            model,
            thinking,
            facet,
            permission_monitor,
        } = opts;
        // base = cwd?.trim() || NEW_SESSION_ENTRY.cwd  (== WORKSPACE_PATH)
        let dir = cwd
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| WORKSPACE_PATH.to_string());
        // sessionId = dir === NEW_SESSION_ENTRY.cwd ? NEW_SESSION_ENTRY.sessionId : `new-${dir}`
        let session_id: SessionId = if dir == WORKSPACE_PATH {
            "new-session".into()
        } else {
            format!("new-{dir}").into()
        };
        // Prepend a synthetic "new" row (unless one for this sessionId already
        // exists) so the new session shows in the sidebar — faithful port of TS
        // `this.sessions = [{ ...NEW_SESSION_ENTRY, sessionId, cwd: dir }, ...]`.
        {
            let mut sessions = self.sessions.lock();
            if !sessions.iter().any(|s| s.session_id == session_id) {
                sessions.insert(0, new_session_entry(session_id.as_str(), &dir));
                self.empty_default.lock().insert(session_id.clone());
            }
        }
        // Build the config: modelId from the draft (or the default),
        // thinkingLevel from the draft (or the default), availableThinkingLevels
        // from the chosen model's entry in MOCK_MODELS (or the default).
        let default = mock_default_config();
        let chosen = model.as_ref().and_then(|m| {
            mock_models()
                .into_iter()
                .find(|opt| opt.model_id == m.model_id)
        });
        let config = SessionConfig {
            model_id: Some(
                model
                    .as_ref()
                    .map(|m| m.model_id.clone())
                    .unwrap_or_else(|| default.model_id.clone().unwrap()),
            ),
            thinking_level: Some(
                thinking.unwrap_or_else(|| default.thinking_level.clone().unwrap()),
            ),
            available_thinking_levels: Some(
                chosen
                    .and_then(|m| m.thinking_levels)
                    .unwrap_or_else(|| default.available_thinking_levels.clone().unwrap()),
            ),
        };
        *self.config.lock() = config.clone();
        let permission_monitor = permission_monitor.unwrap_or(PermissionMonitorMode::BypassPlus);
        let (events, snapshot) = new_session_seed(&dir, config, facet, permission_monitor);
        let session_id = snapshot.r#ref.session_id.clone();
        *self.last_created.lock() = Some(LastCreated {
            session_id,
            snapshot,
        });
        Ok(events)
    }

    async fn set_archived(&self, path: String, archived: bool) -> Result<(), DriverError> {
        // Flip the row's `archived` flag in the mutable session list.
        let mut sessions = self.sessions.lock();
        for s in sessions.iter_mut() {
            if s.path == path {
                s.archived = archived;
            }
        }
        Ok(())
    }

    async fn rename_session(&self, path: String, name: String) -> Result<(), DriverError> {
        // Faithful port of TS `renameSession()`: set the row's displayName to the
        // trimmed name (no-op on empty).
        let next = name.trim();
        if next.is_empty() {
            return Ok(());
        }
        let mut sessions = self.sessions.lock();
        for s in sessions.iter_mut() {
            if s.path == path {
                s.display_name = Some(next.to_string());
            }
        }
        Ok(())
    }

    async fn list_models(&self) -> Vec<ModelOption> {
        mock_models()
    }
    async fn get_model_defaults(&self) -> ModelDefaults {
        let default = mock_default_config();
        ModelDefaults {
            model_id: default.model_id,
            thinking_level: default.thinking_level,
            favorites: Vec::new(),
            default_permission_monitor: Some(PermissionMonitorMode::BypassPlus),
        }
    }
    async fn list_commands(&self, _session_id: Option<SessionId>) -> Vec<CommandInfo> {
        mock_commands()
    }
    async fn list_facets(&self, _session_id: Option<SessionId>) -> Vec<String> {
        vec!["execute".into(), "plan".into(), "research".into()]
    }
    async fn list_file_index(&self, _session_id: Option<SessionId>) -> (Vec<FileInfo>, bool) {
        (mock_files(), false)
    }
    async fn list_at_refs(&self, _session_id: Option<SessionId>) -> AtRefs {
        AtRefs {
            skills: mock_skills(),
            subagents: mock_subagents(),
        }
    }
    async fn list_files(
        &self,
        query: String,
        _session_id: Option<SessionId>,
        cwd: Option<String>,
        include_ignored: bool,
    ) -> Vec<FileInfo> {
        // A query starting with `~`, `/`, or `..` addresses the filesystem
        // OUTSIDE the project — mirrors the real driver's dispatch in
        // `polytoken/driver.rs::list_files`, but looks the query up in the
        // synthetic `mock_external_tree()` instead of resolving + reading a
        // real directory (the mock never touches the real disk).
        if crate::polytoken::file_search::is_external_query(&query) {
            return mock_list_external(&query, include_ignored);
        }
        // Faithful port of TS `MockDriver.listFiles()` (`server/src/mock-driver.ts:764-788`):
        // a new-session draft passes its target cwd — surface it as a synthetic
        // `<cwd>/DRAFT-CWD.md` match so the draft @-mention path
        // (Composer → store → hub → driver) is verifiable end-to-end; the real
        // driver actually searches that dir. A real session passes no cwd, so the
        // marker is absent. Then case-insensitive substring filter, sort by path
        // length, cap at 20.
        // Shift+Tab picker parity: `.env`/`dist/bundle.js`-style fixtures only
        // surface when the ignore toggle is on — mirrors the real driver
        // revealing dotfiles/gitignored entries only with `include_ignored: true`.
        // Prepended (not appended) so the bare-`@` head (capped at 20, below)
        // still surfaces them — `mock_files()` alone already fills the cap.
        let mut pool: Vec<FileInfo> = if include_ignored {
            let mut ignored = mock_ignored_files();
            ignored.extend(mock_files());
            ignored
        } else {
            mock_files()
        };
        if let Some(cwd) = cwd {
            let trimmed = cwd.trim_end_matches('/');
            pool.insert(
                0,
                FileInfo {
                    path: format!("{trimmed}/DRAFT-CWD.md"),
                    is_directory: false,
                },
            );
        }
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return pool.into_iter().take(20).collect();
        }
        let mut matched: Vec<FileInfo> = pool
            .into_iter()
            .filter(|f| f.path.to_lowercase().contains(&q))
            .collect();
        // sort_by is stable; sort by path length to match TS.
        matched.sort_by_key(|f| f.path.len());
        matched.truncate(20);
        matched
    }
    async fn list_dir(&self, path: Option<String>) -> DirListing {
        // Faithful port of TS `listDir()`: resolve the (possibly-empty) path, look
        // it up in the synthetic MOCK_DIR_TREE, and return its entries + parent.
        // Empty → $HOME (the picker's default open). Unknown dirs come back empty
        // (the mock never touches the real disk). The picker navigates by `parent`
        // (Backspace-up) and child `entries`, so both must be right or it hangs.
        let dir = mock_resolve(path.as_deref());
        let parent = std::path::Path::new(&dir)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| p != &dir);
        let known = mock_dir_tree().get(&dir);
        let entries = known.cloned().unwrap_or_default();
        DirListing {
            path: dir,
            parent,
            entries,
            error: known.is_none().then_some(true),
        }
    }
    async fn stat_path(&self, path: String) -> PathStat {
        // Faithful port of TS `statPath()`: existence comes from the synthetic
        // MOCK_DIR_TREE (never the real disk) so a typed-but-fixture path like
        // /Users/timo/src/demo reports as existing on a dev host where it doesn't.
        let abs = mock_resolve(Some(&path));
        let exists = mock_dir_tree().contains_key(&abs);
        PathStat {
            path: abs,
            exists,
            is_dir: exists,
        }
    }

    async fn list_jobs(
        &self,
        _session_id: Option<SessionId>,
    ) -> Result<Vec<BackgroundJob>, DriverError> {
        Ok(self.jobs.lock().clone())
    }

    async fn delete_todo(
        &self,
        _session_id: Option<SessionId>,
        id: i64,
    ) -> Result<(), TodoDeleteError> {
        let mut todos = self.todos.lock();
        if let Some(pos) = todos.iter().position(|t| t.id == id) {
            // Check if any other todo depends on this one
            let dependents: Vec<&TodoItem> = todos
                .iter()
                .filter(|t| t.dependencies.contains(&id))
                .collect();
            if !dependents.is_empty() {
                return Err(TodoDeleteError::DependentsExist(
                    dependents
                        .iter()
                        .map(|t| crate::driver::TodoDeleteDependent {
                            id: t.id,
                            title: t.title.clone(),
                        })
                        .collect(),
                ));
            }
            todos.remove(pos);
            drop(todos);
            // Emit a snapshot update so the sidebar reflects the removal.
            // The real daemon emits SessionStateChanged { domains: ["todos"] }
            // which triggers a FetchState → SessionUpdated. The mock shortcuts
            // by emitting the SessionUpdated directly.
            let mut snap = mock_snapshot(SessionStatus::Idle);
            snap.todos = Some(self.todos.lock().clone());
            self.emit(SessionDriverEvent::SessionUpdated {
                base: base(),
                snapshot: snap,
            });
            Ok(())
        } else {
            Err(TodoDeleteError::NotFound)
        }
    }

    fn get_usage(&self, _session_id: Option<SessionId>) -> Option<SessionUsage> {
        let tokens = LIVE_USAGE_TOKENS.fetch_add(2800, Ordering::Relaxed) + 2800;
        let tokens = tokens.min(200000) as i64;
        let percent = ((tokens as f64 / 200000.0) * 1000.0).round() / 10.0;
        Some(SessionUsage {
            tokens: Some(tokens),
            context_window: 200000,
            percent: Some(percent),
        })
    }

    // One arm per SessionAction, each a faithful port of its TS MockDriver
    // method: deterministic fixture responses so Settings toggles and the
    // context actions round-trip through hub → client in dev/e2e.
    async fn session_action(
        &self,
        action: SessionAction,
        session_id: Option<SessionId>,
    ) -> Result<(), DriverError> {
        // Stamp events with the target session (falls back to the default mock
        // session when no target is given — the historical behavior).
        let sid = session_id.unwrap_or_else(|| SESSION_ID.into());
        if matches!(
            &action,
            SessionAction::SetModel { .. }
                | SessionAction::SetThinking { .. }
                | SessionAction::SetFacet { .. }
                | SessionAction::SetPermissionMonitor { .. }
                | SessionAction::ToggleAdventurousHandoff
        ) {
            self.live_config_actions.lock().insert(sid.clone());
        }
        let base = || SessionEventBase {
            session_ref: session_ref_for(sid.as_str()),
            timestamp: ts(),
            run_id: None,
            subagent_handle: None,
        };
        match action {
            SessionAction::SetModel {
                model_id,
                thinking_level,
            } => {
                let mut config = self.config.lock();
                config.model_id = Some(model_id.clone());
                if let Some(level) = &thinking_level {
                    config.thinking_level = Some(level.clone());
                }
                let mut snapshot = snap(SessionStatus::Idle, None, None, None, None, None);
                snapshot.config = Some(config.clone());
                drop(config);
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot,
                });
                let mut message = format!("Model switched to {model_id}");
                if let Some(level) = &thinking_level {
                    message.push_str(&format!(" (thinking: {level})"));
                }
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("model-switch-{}", ts()),
                        message,
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::SetThinking { level } => {
                let mut config = self.config.lock();
                config.thinking_level = Some(level.clone());
                let mut snapshot = snap(SessionStatus::Idle, None, None, None, None, None);
                snapshot.config = Some(config.clone());
                drop(config);
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot,
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("thinking-switch-{}", ts()),
                        message: format!("Thinking level set to {level}"),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::SetFacet { facet } => {
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot: snap(
                        SessionStatus::Idle,
                        Some(facet.clone()),
                        None,
                        None,
                        None,
                        None,
                    ),
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("facet-switch-{}", ts()),
                        message: format!("Facet switched to {facet}"),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::SetPermissionMonitor { mode } => {
                let mut s = snap(SessionStatus::Idle, None, None, None, None, None);
                s.permission_monitor = Some(mode);
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot: s,
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("permission-monitor-switch-{}", ts()),
                        message: format!("Permission monitor set to {:?}", mode),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::ToggleAdventurousHandoff => {
                // Flip the local flag and broadcast a sessionUpdated snapshot
                // carrying the new value.
                let flipped = {
                    let mut g = self.adventurous_handoff.lock().unwrap();
                    *g = !*g;
                    *g
                };
                let mut s = snap(SessionStatus::Idle, None, None, None, None, None);
                s.adventurous_handoff = Some(flipped);
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot: s,
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("adventurous-handoff-{}", ts()),
                        message: format!(
                            "Adventurous handoff {}",
                            if flipped { "enabled" } else { "disabled" }
                        ),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::SetNotificationAutodrain { enabled } => {
                // Emit a sessionUpdated whose snapshot carries the new flag.
                let mut snapshot = mock_snapshot(SessionStatus::Idle);
                snapshot.notification_autodrain = Some(enabled);
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot,
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("notification-autodrain-{}", ts()),
                        message: format!(
                            "Notification auto-drain {}",
                            if enabled { "enabled" } else { "disabled" }
                        ),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::Compact => {
                // Drop usage to a small post-compaction residual (the daemon
                // keeps a summary, so context isn't zero), then notify.
                self.emit(SessionDriverEvent::UsageUpdated {
                    base: base(),
                    usage: SessionUsage {
                        tokens: Some(8000),
                        context_window: 200000,
                        percent: Some(4.0),
                    },
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("compact-done-{}", ts()),
                        message: "Context compacted".into(),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::ClearContext => {
                // Usage drops to zero so the ring renders "0%", then notify.
                self.emit(SessionDriverEvent::UsageUpdated {
                    base: base(),
                    usage: SessionUsage {
                        tokens: Some(0),
                        context_window: 200000,
                        percent: Some(0.0),
                    },
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("clear-done-{}", ts()),
                        message: "Context cleared".into(),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::ResetShell => {
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("reset-shell-{}", ts()),
                        message: "Shell environment restored".into(),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::DaemonReload => {
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("daemon-reload-{}", ts()),
                        message: "Daemon config reloaded".into(),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::GoalSet { summary } => {
                let goal = GoalInfo {
                    summary: summary.clone(),
                    lifecycle: "active".into(),
                };
                *self.goal.lock().unwrap() = Some(goal.clone());
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot: snap(
                        SessionStatus::Idle,
                        None,
                        Some(Some(goal)),
                        None,
                        None,
                        None,
                    ),
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("goal-set-{}", ts()),
                        message: format!("Goal set: {summary}"),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::GoalPause => {
                let goal = {
                    let mut g = self.goal.lock().unwrap();
                    if let Some(goal) = g.as_mut() {
                        goal.lifecycle = "paused".into();
                    }
                    g.clone()
                };
                // No-op when no goal is set — don't emit Some(None) which the
                // fold reducer interprets as "goal cleared."
                if goal.is_some() {
                    self.emit(SessionDriverEvent::SessionUpdated {
                        base: base(),
                        snapshot: snap(SessionStatus::Idle, None, Some(goal), None, None, None),
                    });
                    self.emit(SessionDriverEvent::HostUiRequest {
                        base: base(),
                        request: HostUiRequest::Notify {
                            request_id: format!("goal-pause-{}", ts()),
                            message: "Goal paused".into(),
                            level: Some(NotifyLevel::Info),
                        },
                    });
                }
            }
            SessionAction::GoalResume => {
                let goal = {
                    let mut g = self.goal.lock().unwrap();
                    if let Some(goal) = g.as_mut() {
                        goal.lifecycle = "active".into();
                    }
                    g.clone()
                };
                if goal.is_some() {
                    self.emit(SessionDriverEvent::SessionUpdated {
                        base: base(),
                        snapshot: snap(SessionStatus::Idle, None, Some(goal), None, None, None),
                    });
                    self.emit(SessionDriverEvent::HostUiRequest {
                        base: base(),
                        request: HostUiRequest::Notify {
                            request_id: format!("goal-resume-{}", ts()),
                            message: "Goal resumed".into(),
                            level: Some(NotifyLevel::Info),
                        },
                    });
                }
            }
            SessionAction::GoalClear => {
                *self.goal.lock().unwrap() = None;
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot: snap(SessionStatus::Idle, None, Some(None), None, None, None),
                });
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("goal-clear-{}", ts()),
                        message: "Goal cleared".into(),
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
            SessionAction::SetTitle { title } => {
                let mut snapshot = mock_snapshot(SessionStatus::Idle);
                // Empty title = clear override → revert to the inferred title
                // (matches daemon's POST /title with empty string).
                if !title.is_empty() {
                    snapshot.title = title;
                }
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot,
                });
            }
            SessionAction::SetMcpServer {
                server_name,
                action,
            } => {
                // Reflect the action on the named server so the Settings round-trip
                // is observable: enable/reconnect → connected, disable/disconnect →
                // disconnected. Reads the payload (server_name + action) — a broken
                // wire/hub/driver path would send the wrong name or drop the message
                // and the emitted snapshot wouldn't change.
                let connected = matches!(action, McpAction::Enable | McpAction::Reconnect);
                let status = if connected {
                    McpServerStatus::Connected
                } else {
                    McpServerStatus::Disconnected
                };
                let servers = mock_mcp_servers()
                    .into_iter()
                    .map(|mut s| {
                        if s.server_name == server_name {
                            s.status = status;
                            s.tool_count = if connected { 5 } else { 0 };
                        }
                        s
                    })
                    .collect();
                let mut snapshot = mock_snapshot(SessionStatus::Idle);
                snapshot.mcp_servers = Some(servers);
                self.emit(SessionDriverEvent::SessionUpdated {
                    base: base(),
                    snapshot,
                });
            }
        }
        Ok(())
    }

    fn default_seed(&self) -> Option<Vec<SessionDriverEvent>> {
        Some(greeting_seed())
    }

    fn run_script(&self, name: String) {
        let steps: Vec<ScriptStep> = match name.as_str() {
            // Keep this one-shot delay out of normal fixtures. It delays the
            // entire abort() call by 1000ms, so no abortResult arrives within
            // the 500ms no-response timeout — tests the no-response path: the
            // timer fires and the stop button shows a retryable "unconfirmed"
            // state (on the stop button only, no chat toast or sidebar error).
            "slowabort" => {
                self.abort_delay_ms.store(1000, Ordering::SeqCst);
                return;
            }
            // Widen the client's warm-up window (2s) so e2e can assert the composer
            // badges hold the draft's values (not daemon defaults) while the seed is
            // pending. Mirrors `slowabort`'s one-shot delay pattern.
            "slownewsession" => {
                self.new_session_seed_delay_ms.store(2000, Ordering::SeqCst);
                return;
            }
            // Simulates the real daemon's behavior during a tool call: the
            // cancel is accepted immediately (abortResult { accepted: true }
            // arrives fast) but the terminal RunCompleted event is delayed by
            // 1000ms (the tool takes time to interrupt). Tests the core fix —
            // an accepted stop must NOT produce a false "unconfirmed" state.
            "toolhold" => {
                self.abort_settle_delay_ms.store(1000, Ordering::SeqCst);
                return;
            }
            // Inject 6 extra sessions into the WORKSPACE_PATH project so the
            // sidebar's per-group cap (5) triggers a "Show more" button. Used by
            // the e2e test (drive(page, "manysessions")). Mutates session state
            // directly, like `new_session` — a return-early script with no
            // ScriptStep. The client re-reads the list on the next sidebar open.
            "manysessions" => {
                let mut sessions = self.sessions.lock();
                let now = chrono::Utc::now();
                let iso_ago = |ms: i64| {
                    (now - chrono::Duration::milliseconds(ms))
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                };
                for i in 0..6 {
                    sessions.push(SessionListEntry {
                        session_id: format!("extra-session-{i}").into(),
                        path: format!("/sessions/extra-session-{i}.jsonl"),
                        cwd: WORKSPACE_PATH.into(),
                        display_name: Some(format!("Extra task #{i}")),
                        preview: format!("Extra session number {i} for testing the cap."),
                        user_message_count: 1,
                        usage: None,
                        updated_at: iso_ago((i + 1) * 60_000),
                        created_at: iso_ago((i + 1) * 60_000),
                        last_user_message_at: iso_ago((i + 1) * 60_000),
                        parent_session_path: None,
                        archived: false,
                    });
                }
                return;
            }
            // ── Approval dialogs ────────────────────────────────────────────
            "confirm" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Confirm {
                    request_id: "req-confirm-1".into(),
                    title: "Run destructive command?".into(),
                    message: "The agent wants to run `git reset --hard origin/main`. This discards all local changes. Allow?".into(),
                    default_value: Some(false),
                    timeout_ms: Some(60000),
                } } },
            ],
            "goal" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Confirm {
                    request_id: "req-goal-1".into(),
                    title: "Ship feature X".into(),
                    message: "Implement the new dashboard widget".into(),
                    default_value: None,
                    timeout_ms: None,
                } } },
            ],
            "unknown" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Unknown {
                    request_id: "req-unknown-1".into(),
                    title: "⚠ Unknown request type: some_future_type".into(),
                    message: "The agent sent a request type this version of pantoken doesn't recognize. Dismiss to cancel it and unblock the session.".into(),
                } } },
            ],
            "input" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Input {
                    request_id: "req-input-1".into(),
                    title: "Commit message".into(),
                    placeholder: Some("Describe the change…".into()),
                    initial_value: Some("Add /health route".into()),
                    timeout_ms: None,
                } } },
            ],
            "editor" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Editor {
                    request_id: "req-editor-1".into(),
                    title: "Edit release notes".into(),
                    initial_value: Some("Added the approval shelf.\nPreserved draft safety.".into()),
                } } },
            ],
            "qna" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Qna {
                    request_id: "req-qna-1".into(),
                    title: Some("A few questions before I proceed".into()),
                    questions: vec![
                        QnaQuestion {
                            question: "Which package manager should I use?".into(),
                            context: Some("The repo has both a `bun.lock` and a `package-lock.json`.\n\n**Note:** `bun` is recommended for speed.".into()),
                            multi_select: None,
                            options: Some(vec![
                                QnaQuestionOption { label: "bun".into(), description: Some("Matches bun.lock (recommended)".into()) },
                                QnaQuestionOption { label: "npm".into(), description: Some("Matches package-lock.json".into()) },
                                QnaQuestionOption { label: "pnpm".into(), description: None },
                            ]),
                        },
                        QnaQuestion {
                            question: "Which checks should run before each commit?".into(),
                            context: None,
                            multi_select: Some(true),
                            options: Some(vec![
                                QnaQuestionOption { label: "Typecheck".into(), description: None },
                                QnaQuestionOption { label: "Unit tests".into(), description: None },
                                QnaQuestionOption { label: "Lint".into(), description: None },
                                QnaQuestionOption { label: "e2e".into(), description: None },
                            ]),
                        },
                        QnaQuestion {
                            question: "Anything else I should know before starting?".into(),
                            context: None,
                            multi_select: None,
                            options: None,
                        },
                    ],
                    timeout_ms: None,
                } } },
            ],
            // Like `qna` but with a long context on Q1/Q2 so the `.ctx` region
            // overflows and scroll-independence between pages is testable.
            "qnatall" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Qna {
                    request_id: "req-qna-tall-1".into(),
                    title: Some("Scroll independence test".into()),
                    questions: vec![
                        QnaQuestion {
                            question: "Pick the first option (long context)".into(),
                            context: Some(LONG_QNA_CONTEXT.into()),
                            multi_select: None,
                            options: Some(vec![
                                QnaQuestionOption { label: "Alpha".into(), description: None },
                                QnaQuestionOption { label: "Beta".into(), description: None },
                                QnaQuestionOption { label: "Gamma".into(), description: None },
                            ]),
                        },
                        QnaQuestion {
                            question: "Pick the second option (long context)".into(),
                            context: Some(LONG_QNA_CONTEXT.into()),
                            multi_select: None,
                            options: Some(vec![
                                QnaQuestionOption { label: "Delta".into(), description: None },
                                QnaQuestionOption { label: "Epsilon".into(), description: None },
                                QnaQuestionOption { label: "Zeta".into(), description: None },
                            ]),
                        },
                        QnaQuestion {
                            question: "Any final notes?".into(),
                            context: None,
                            multi_select: None,
                            options: None,
                        },
                    ],
                    timeout_ms: None,
                } } },
            ],
            "timeout" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Confirm {
                    request_id: "req-timeout-1".into(),
                    title: "Auto-resolving confirm".into(),
                    message: "This dialog auto-dismisses (deny-safe) if you don't respond.".into(),
                    default_value: Some(false),
                    timeout_ms: Some(3000),
                } } },
            ],
            "yesno" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Select {
                    request_id: "req-yesno-1".into(),
                    title: "Apply the suggested fix?".into(),
                    options: vec!["Don't allow".into(), "Allow".into()],
                    allow_multiple: None,
                    timeout_ms: None,
                } } },
            ],
            // ── Ambient (fire-and-forget) UI ────────────────────────────────
            "ambient" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Status {
                    request_id: "s1".into(),
                    key: "branch".into(),
                    text: Some("on main · 2 files changed".into()),
                } } },
                ScriptStep { wait_ms: 80, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Widget {
                    request_id: "w1".into(),
                    key: "tasklist".into(),
                    lines: Some(vec![
                        "Open Tasks (3):".into(),
                        "  ○ wire up /health route".into(),
                        "  ○ add a smoke test".into(),
                        "  ○ document the deploy step".into(),
                    ]),
                    placement: Some(WidgetPlacement::AboveComposer),
                } } },
                ScriptStep { wait_ms: 80, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Notify {
                    request_id: "n1".into(),
                    message: "Background indexing finished".into(),
                    level: Some(NotifyLevel::Info),
                } } },
            ],
            "context" => {
                // Populate the mock's job + todo fixtures so the hub's
                // SessionUpdated → list_jobs() broadcast carries the jobs, and
                // delete_todo has the right baseline.
                *self.jobs.lock() = mock_context_jobs();
                *self.todos.lock() = mock_default_todos();
                vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, None, None, None,
                    Some(vec![
                        FlaggedFile { path: "src/app.ts".into(), mode: FlaggedFileMode::Included },
                        FlaggedFile { path: "src/lib/store.svelte.ts".into(), mode: FlaggedFileMode::Included },
                        FlaggedFile { path: "README.md".into(), mode: FlaggedFileMode::Referenced },
                    ]),
                    Some(vec![
                        TodoItem { id: 1, title: "Wire up the right sidebar".into(), description: "Add protocol types, event-map threading, and the drawer component".into(), status: TodoStatus::InProgress, dependencies: vec![], created_at: Some("2025-07-09T10:00:00Z".into()) },
                        TodoItem { id: 2, title: "Add e2e tests".into(), description: "Assert flagged files + todos render, toggle opens/closes".into(), status: TodoStatus::Pending, dependencies: vec![1], created_at: Some("2025-07-09T10:05:00Z".into()) },
                        TodoItem { id: 3, title: "Review with subagent".into(), description: "Check type safety, overwrite-guard consistency, tooltips".into(), status: TodoStatus::Pending, dependencies: vec![2], created_at: Some("2025-07-09T10:10:00Z".into()) },
                    ]),
                ) } },
                ]
            }
            "jobvisual" => {
                // Isolated four-state fixture for the RightSidebar visual-state e2e
                // checks. The snapshot event triggers the normal JobsList broadcast.
                *self.jobs.lock() = mock_visual_jobs();
                vec![ScriptStep {
                    wait_ms: 0,
                    event: SessionDriverEvent::SessionUpdated {
                        base: base(),
                        snapshot: snap(SessionStatus::Idle, None, None, None, None, None),
                    },
                }]
            }
            // ── Session state scripts ─────────────────────────────────────
            "goalactive" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, None, Some(Some(GoalInfo { summary: "Ship the goal badge feature".into(), lifecycle: "active".into() })), None, None, None,
                ) } },
            ],
            "goalclear" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, None, Some(None), None, None, None,
                ) } },
            ],
            "planview" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, Some("plan".into()), None,
                    Some("# Plan: Wire up the plan overlay\n\n## Steps\n1. Add `activePlan` to the SessionSnapshot protocol\n2. Thread `active_plan` through the event-map\n3. Build the PlanView modal + StatusHeader button\n\n## Notes\n- The overlay is read-only — no editing from inside it\n- Renders via Markdown.svelte (same as the plan-handoff card)\n".into()),
                    None, None,
                ) } },
            ],
            "initializing" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionOpened { base: base(), snapshot: snap(SessionStatus::Initializing, None, None, None, None, None) } },
                ScriptStep { wait_ms: 1200, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(SessionStatus::Idle, None, None, None, None, None) } },
            ],
            // Boundary-heavy ToolCard fixture. Dev/e2e only: exercises bounded display,
            // full-output copy, and every visual tool status without production behavior.
            "toolpolish" => {
                let mut exact_args = serde_json::Map::new();
                for i in 0..40 {
                    exact_args.insert(format!("exact_field_{i:02}"), serde_json::json!(i));
                }
                let mut args = serde_json::Map::new();
                args.insert("a_exact_value".into(), serde_json::Value::String("X".repeat(20_000)));
                args.insert("b_over_value".into(), serde_json::Value::String(format!("{}ARG_TAIL", "Y".repeat(20_000))));
                for i in 0..39 {
                    args.insert(format!("z_field_{i:02}"), serde_json::json!(i));
                }

                let mut s = vec![ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated {
                    base: base(), snapshot: mock_snapshot(SessionStatus::Running),
                } }];
                s.extend(tool_span("polish-header-exact", "header_exact", "Header exact", None,
                    serde_json::json!({"command": "H".repeat(320)}), true, serde_json::json!("ok"), 0, 0, 1));
                s.extend(tool_span("polish-header-over", "header_over", "Header over", None,
                    serde_json::json!({"command": "H".repeat(321)}), true, serde_json::json!("ok"), 0, 0, 1));
                s.extend(tool_span("polish-args-exact", "args_exact", "Args exact 40", None,
                    serde_json::Value::Object(exact_args), true, serde_json::json!("ok"), 0, 0, 1));
                s.extend(tool_span("polish-args", "bounded_args", "Bounded args", None,
                    serde_json::Value::Object(args), true, serde_json::json!("ok"), 0, 0, 1));
                s.extend(tool_span("polish-output-exact", "output_exact", "Output exact", None,
                    serde_json::json!({}), true, serde_json::Value::String("E".repeat(50_000)), 0, 0, 1));
                s.extend(tool_span("polish-output-over", "output_over", "Output over", None,
                    serde_json::json!({}), true, serde_json::Value::String(format!("{}OUTPUT_TAIL", "P".repeat(50_000))), 0, 0, 1));
                s.extend(tool_span("polish-output-blocks", "output_blocks", "Output blocks", None,
                    serde_json::json!({}), true, serde_json::json!({"content": [
                        {"type": "text", "text": "A".repeat(30_000)},
                        {"type": "text", "text": format!("{}MULTI_TAIL", "B".repeat(20_000))},
                    ]}), 0, 0, 1));
                s.extend(tool_span("polish-error", "failed_tool", "Failed tool", None,
                    serde_json::json!({}), false, serde_json::json!("partial failure output"), 0, 0, 1));

                s.push(ScriptStep { wait_ms: 0, event: SessionDriverEvent::ToolStarted {
                    base: base(), call_id: "polish-interrupted".into(), tool_name: "interrupted_tool".into(),
                    label: Some("Interrupted tool".into()), description: None, input: Some(serde_json::json!({})),
                } });
                advance_ts(1);
                s.push(ScriptStep { wait_ms: 0, event: SessionDriverEvent::ToolFinished {
                    base: base(), call_id: "polish-interrupted".into(), success: false,
                    output: Some(serde_json::json!("partial interrupted output")), images: None,
                    interrupted: Some(true),
                } });
                s.push(ScriptStep { wait_ms: 0, event: SessionDriverEvent::ToolStarted {
                    base: base(), call_id: "polish-running".into(), tool_name: "running_tool".into(),
                    label: Some("Running tool".into()), description: None, input: Some(serde_json::json!({})),
                } });
                s.push(ScriptStep { wait_ms: 0, event: SessionDriverEvent::ToolUpdated {
                    base: base(), call_id: "polish-running".into(),
                    text: Some(format!("{}STREAM_TAIL", "S".repeat(50_000))), progress: Some(0.5),
                } });
                s
            }
            // ── Clean tool previews ────────────────────────────────────────
            // Exercises every tool whose collapsed-header `.arg` preview was
            // refined in #28, so e2e can assert the per-tool field selection.
            "cleantools" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Show me the clean tool previews.".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Running the full set of tools for header-preview verification.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                // write_plan / edit_plan / handoff_plan — empty previews
                s.extend(tool_span("ct-write-plan", "write_plan", "Write plan", None,
                    serde_json::json!({"content": "# Goal\nDo the thing"}), true, serde_json::json!("Plan written"), 0, 0, 1));
                s.extend(tool_span("ct-edit-plan", "edit_plan", "Edit plan", None,
                    serde_json::json!({"old_string": "old", "new_string": "new"}), true, serde_json::json!("Plan edited"), 0, 0, 1));
                s.extend(tool_span("ct-handoff-plan", "handoff_plan", "Hand off plan", None,
                    serde_json::json!({"facet": "execute"}), true, serde_json::json!("Plan handed off"), 0, 0, 1));
                // todo tools
                s.extend(tool_span("ct-todo-create", "todo_create", "Create todo", None,
                    serde_json::json!({"title": "Fix the bug", "description": "..."}), true, serde_json::json!("Todo created"), 0, 0, 1));
                s.extend(tool_span("ct-todo-list", "todo_list", "List todos", None,
                    serde_json::json!({"status_filter": "pending"}), true, serde_json::json!("3 todos found"), 0, 0, 1));
                s.extend(tool_span("ct-todo-update", "todo_update", "Update todo", None,
                    serde_json::json!({"id": 2, "title": "Updated title"}), true, serde_json::json!("Todo updated"), 0, 0, 1));
                s.extend(tool_span("ct-todo-complete", "todo_complete", "Complete todo", None,
                    serde_json::json!({"id": 1}), true, serde_json::json!("Todo completed"), 0, 0, 1));
                // subagent (model_override null → omitted from preview)
                s.extend(tool_span("ct-subagent", "subagent", "Run subagent", None,
                    serde_json::json!({"name": "code-reviewer", "subagent_type": "general-purpose", "model_override": null, "prompt": "..."}), true, serde_json::json!("Done"), 0, 0, 1));
                // skill
                s.extend(tool_span("ct-skill", "skill", "Load skill", None,
                    serde_json::json!({"name": "debug"}), true, serde_json::json!("Skill loaded"), 0, 0, 1));
                // job_status / job_block
                s.extend(tool_span("ct-job-status", "job_status", "Check job status", None,
                    serde_json::json!({"job_id": "general-purpose:example"}), true, serde_json::json!("completed"), 0, 0, 1));
                s.extend(tool_span("ct-job-block", "job_block", "Wait for job", None,
                    serde_json::json!({"job_id": "general-purpose:example", "wait_seconds": 60, "timeout_seconds": 90}), true, serde_json::json!("finished"), 0, 0, 1));
                // block_goal — amber terminal_reason
                s.extend(tool_span("ct-block-goal", "block_goal", "Block goal", None,
                    serde_json::json!({"terminal_reason": "Waiting on missing credentials"}), true, serde_json::json!("Goal blocked"), 0, 0, 1));
                // propose_goal
                s.extend(tool_span("ct-propose-goal", "propose_goal", "Propose goal", None,
                    serde_json::json!({"summary": "Finish implementing the feature"}), true, serde_json::json!("Goal proposed"), 0, 0, 1));
                // popd — empty input
                s.extend(tool_span("ct-popd", "popd", "Pop directory", None,
                    serde_json::json!({}), true, serde_json::json!("Popped"), 0, 0, 1));
                // web_search — output is a plain string containing a JSON array,
                // matching the live daemon's serde_json::Value::String shape.
                s.extend(tool_span("ct-web-search", "web_search", "Web search", None,
                    serde_json::json!({"query": "weather munich"}), true,
                    serde_json::json!("[{\"title\":\"Weather in Munich\",\"url\":\"https://example.com/1\"},{\"title\":\"Munich Forecast\",\"url\":\"https://example.com/2\"}]"),
                    0, 0, 1));
                for chunk in deltas("All tools ran.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "staleidle" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-stale-{}", ts()), text: "Run the long thing — but glitch the status mid-turn.".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("On it — kicking off a command that takes a while.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 40, event: SessionDriverEvent::ToolStarted {
                    base: base(), call_id: "stale-tool-1".into(), tool_name: "bash".into(),
                    label: Some("Run shell command".into()),
                    description: Some("Execute a command in the workspace shell".into()),
                    input: Some(serde_json::json!({"command": "sleep 30 && echo done"})),
                } });
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Idle) } });
                s
            }
            // ── Turn scripts ───────────────────────────────────────────────
            "pendinghold" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-pending-{}", ts()), text: "Refactor the auth middleware".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me look at how auth is wired before I touch it.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                s
            }
            "idle" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-idle-{}", ts()), text: "End this turn without a runCompleted, please.".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Done — this turn ends with a status update, not a runCompleted event.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 80, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Idle) } });
                s
            }
            // Drives the cwd footer + header subtitle deviation: a live cwd set to
            // a project subdirectory with a non-zero stack depth (pushd'd twice).
            "cwd" => {
                let mut s = snap(SessionStatus::Idle, None, None, None, None, None);
                s.cwd = Some("/Users/timo/src/pantoken/client".into());
                s.cwd_stack_depth = Some(2);
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated {
                        base: base(),
                        snapshot: s,
                    } },
                ]
            }
            // Resets to the project root with depth 0 (no stack badge, no deviation).
            "cwdroot" => {
                let mut s = snap(SessionStatus::Idle, None, None, None, None, None);
                s.cwd = Some("/Users/timo/src/pantoken".into());
                s.cwd_stack_depth = Some(0);
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated {
                        base: base(),
                        snapshot: s,
                    } },
                ]
            }
            "error" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Attempting the network call now.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 120, event: SessionDriverEvent::RunFailed { base: base(), error: SessionErrorInfo { message: "Provider request failed: 529 overloaded (will not auto-retry)".into(), code: None, details: None } } });
                s
            }
            "reply" => prompt_reply_script("Show me the streamed reply script.", None, &[]),
            "promptmaplong" => prompt_map_long_script(),
            "promptmaphold" => prompt_map_hold_script(),
            "promptmaptoolonly" => prompt_map_tool_only_script(),
            // Reproduces #78: a delayed background-agent notification collapses the
            // preceding final assistant response. Emits: userMessage → narration →
            // tool span → finalA (settled response, RunCompleted stamps completedAt) →
            // HostUiRequest::Notify (the late notification) → follow-up deltas →
            // RunCompleted (settles the follow-up so the turn collapses). The
            // second RunCompleted is essential: without it the follow-up stays
            // streaming:true, store.turnActive stays true, applyLastTurnActive
            // forces every work lane non-collapsible, and no work-toggle renders.
            "latenotify" => {
                let u_id = format!("u-ln-{}", ts());
                let call_id = format!("t-ln-{}", ts());
                let mut s = vec![
                    ScriptStep {
                        wait_ms: 0,
                        event: SessionDriverEvent::UserMessage {
                            base: base(),
                            id: u_id.clone(),
                            text: "Run the build and summarize.".into(),
                            images: None,
                            entry_id: Some(format!("e-{u_id}")),
                            references: None,
                        },
                    },
                    ScriptStep {
                        wait_ms: 0,
                        event: SessionDriverEvent::SessionUpdated {
                            base: base(),
                            snapshot: mock_snapshot(SessionStatus::Running),
                        },
                    },
                ];
                // Narration deltas.
                for chunk in deltas("I'll run the build and report the result.", 3) {
                    s.push(ScriptStep {
                        wait_ms: 28,
                        event: SessionDriverEvent::AssistantDelta {
                            base: base(),
                            text: chunk,
                            channel: Some(AssistantDeltaChannel::Text),
                            entry_id: None,
                        },
                    });
                }
                // Tool span — a build run (so the turn has collapsible work).
                s.extend(tool_span(
                    &call_id,
                    "bash",
                    "Run shell command",
                    Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "cargo build"}),
                    true,
                    serde_json::json!("   Compiling pantoken-server v0.5.0\n    Finished dev [unoptimized + debuginfo] target(s)"),
                    120,
                    220,
                    980,
                ));
                // Second tool span — a test run (≥2 threshold needs 2 tools to collapse).
                let call_id_2 = format!("t2-ln-{}", ts());
                s.extend(tool_span(
                    &call_id_2,
                    "bash",
                    "Run shell command",
                    Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "cargo test -- --list"}),
                    true,
                    serde_json::json!("32 tests found"),
                    80,
                    180,
                    600,
                ));
                // finalA — the settled response (RunCompleted stamps completedAt).
                for chunk in deltas(
                    "Build succeeded with no warnings. The server compiles cleanly and is ready to ship.",
                    3,
                ) {
                    s.push(ScriptStep {
                        wait_ms: 28,
                        event: SessionDriverEvent::AssistantDelta {
                            base: base(),
                            text: chunk,
                            channel: Some(AssistantDeltaChannel::Text),
                            entry_id: None,
                        },
                    });
                }
                // RunCompleted settles finalA: closes its bubble, stamps completedAt,
                // flips streaming:false (the idle snapshot path).
                s.push(ScriptStep {
                    wait_ms: 60,
                    event: SessionDriverEvent::RunCompleted {
                        base: base(),
                        snapshot: mock_snapshot(SessionStatus::Idle),
                        user_entry_id: Some(format!("e-{u_id}")),
                        assistant_entry_id: Some("e-a-finalA".into()),
                    },
                });
                // The delayed background-agent notification (HostUiRequest::Notify).
                // Folds into a `notice` transcript item that lands AFTER finalA.
                s.push(ScriptStep {
                    wait_ms: 200,
                    event: SessionDriverEvent::HostUiRequest {
                        base: base(),
                        request: HostUiRequest::Notify {
                            request_id: "ln-notify".into(),
                            message: "Subagent general-purpose: Success".into(),
                            level: Some(NotifyLevel::Info),
                        },
                    },
                });
                // The follow-up acknowledging the notification.
                s.push(ScriptStep {
                    wait_ms: 0,
                    event: SessionDriverEvent::SessionUpdated {
                        base: base(),
                        snapshot: mock_snapshot(SessionStatus::Running),
                    },
                });
                for chunk in deltas("Noted — the background subagent finished successfully.", 3) {
                    s.push(ScriptStep {
                        wait_ms: 28,
                        event: SessionDriverEvent::AssistantDelta {
                            base: base(),
                            text: chunk,
                            channel: Some(AssistantDeltaChannel::Text),
                            entry_id: None,
                        },
                    });
                }
                // RunCompleted settles the follow-up (closes its bubble, stamps
                // completedAt, flips streaming:false) so the turn collapses.
                s.push(ScriptStep {
                    wait_ms: 60,
                    event: SessionDriverEvent::RunCompleted {
                        base: base(),
                        snapshot: mock_snapshot(SessionStatus::Idle),
                        user_entry_id: Some(format!("e-{u_id}")),
                        assistant_entry_id: Some("e-a-followup".into()),
                    },
                });
                s
            }
            // ── Background session scripts ────────────────────────────────
            "bgrun" => {
                let ref_id = session_ref_for("older-session");
                let snap_bg = |status: SessionStatus| SessionSnapshot {
                    r#ref: ref_id.clone(),
                    workspace: mock_workspace(),
                    title: "Explore the fold reducer".into(),
                    status,
                    updated_at: ts(),
                    archived_at: None, preview: None, config: None, usage: None,
                    running_run_id: None, queued_messages: None, facet: None,
                    permission_monitor: None, adventurous_handoff: None,
                    notification_autodrain: None, active_plan: None, goal: None,
                    flags: None, todos: None, mcp_servers: None,
                    cwd: None, cwd_stack_depth: None,
                };
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None, subagent_handle: None }, snapshot: snap_bg(SessionStatus::Running) } },
                    ScriptStep { wait_ms: 300, event: SessionDriverEvent::AssistantDelta { base: SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None, subagent_handle: None }, text: "(background turn)".into(), channel: Some(AssistantDeltaChannel::Text), entry_id: None } },
                    ScriptStep { wait_ms: 1500, event: SessionDriverEvent::RunCompleted { base: SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None, subagent_handle: None }, snapshot: snap_bg(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } },
                ]
            }
            "bgwait" => {
                let ref_id = session_ref_for("older-session");
                let snap_bg = SessionSnapshot {
                    r#ref: ref_id.clone(),
                    workspace: mock_workspace(),
                    title: "Explore the fold reducer".into(),
                    status: SessionStatus::Running,
                    updated_at: ts(),
                    archived_at: None, preview: None, config: None, usage: None,
                    running_run_id: None, queued_messages: None, facet: None,
                    permission_monitor: None, adventurous_handoff: None,
                    notification_autodrain: None, active_plan: None, goal: None,
                    flags: None, todos: None, mcp_servers: None,
                    cwd: None, cwd_stack_depth: None,
                };
                let b = || SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None, subagent_handle: None };
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: b(), snapshot: snap_bg } },
                    ScriptStep { wait_ms: 80, event: SessionDriverEvent::ToolStarted {
                        base: b(), call_id: "bg-read".into(), tool_name: "read".into(),
                        label: Some("Read file".into()), description: None,
                        input: Some(serde_json::json!({"path": "docs/TODO.md"})),
                    } },
                    ScriptStep { wait_ms: 120, event: SessionDriverEvent::HostUiRequest { base: b(), request: HostUiRequest::Confirm {
                        request_id: "bg-approval".into(),
                        title: "Review background change".into(),
                        message: "Apply the queued background edit?".into(),
                        default_value: None, timeout_ms: None,
                    } } },
                ]
            }
            // ── Edit diff ──────────────────────────────────────────────────
            "editdiff" => tool_span(
                "edit-1", "edit", "Edit file", Some("Apply edits to a file in the workspace"),
                serde_json::json!({
                    "path": "server/src/health.ts",
                    "edits": [{
                        "oldText": "export function health() {\n  return new Response(\"ok\");\n}",
                        "newText": "export function health() {\n  return Response.json({ status: \"ok\", uptime: process.uptime() });\n}",
                    }]
                }),
                true,
                serde_json::json!("Successfully replaced 1 block(s) in server/src/health.ts"),
                0, 200, 480,
            ),
            "editbounds" => {
                let old_text = format!(
                    "OLD_PREVIEW_MARKER\n{}OLD_EDIT_TAIL",
                    "old line\n".repeat(599)
                );
                let new_text = format!(
                    "NEW_PREVIEW_MARKER\n{}NEW_EDIT_TAIL",
                    "new line\n".repeat(599)
                );
                let patch = format!(
                    "--- a/src/oversized.ts\n+++ b/src/oversized.ts\n@@ -1 +1 @@\n-PATCH_PREFIX_MARKER{}\n+replacement\nPATCH_TAIL",
                    "P".repeat(25_000)
                );
                tool_span(
                    "edit-bounds-1", "edit", "Oversized edit", Some("Exercise bounded edit previews"),
                    serde_json::json!({
                        "path": "src/oversized.ts",
                        "edits": [{ "oldText": old_text, "newText": new_text }]
                    }),
                    true,
                    serde_json::json!({
                        "content": [{ "type": "text", "text": "edit completed RESULT_TAIL" }],
                        "details": { "patch": patch }
                    }),
                    0, 0, 1,
                )
            }
            "editpatch" => tool_span(
                "edit-patch-1", "edit", "Rich patch edit", Some("Exercise the rich patch preview branch"),
                serde_json::json!({
                    "path": "src/patch.ts",
                    "edits": [{
                        "oldText": "INPUT_SIDE_OLD".repeat(2_000),
                        "newText": "INPUT_SIDE_NEW".repeat(2_000)
                    }]
                }),
                true,
                serde_json::json!({
                    "content": [{ "type": "text", "text": "patch applied" }],
                    "details": { "patch": "diff --git a/src/patch.ts b/src/patch.ts\n--- a/src/patch.ts\n+++ b/src/patch.ts\n@@ -1 +1 @@\n-PATCH_BRANCH_OLD\n+PATCH_BRANCH_NEW\n" }
                }),
                0, 0, 1,
            ),
            "editcountguard" => {
                let old_text = format!(
                    "GUARD_OLD_START\n{}GUARD_OLD_TAIL",
                    "guard old\n".repeat(4_999)
                );
                let new_text = format!(
                    "GUARD_NEW_START\n{}GUARD_NEW_TAIL",
                    "guard new\n".repeat(399)
                );
                tool_span(
                    "edit-count-guard-1", "edit", "Huge line-count edit", Some("Exercise the edit count work guard"),
                    serde_json::json!({
                        "path": "src/huge-lines.ts",
                        "edits": [{ "oldText": old_text, "newText": new_text }]
                    }),
                    true,
                    serde_json::json!("large edit applied"),
                    0, 0, 1,
                )
            }
            "editemptyguards" => {
                let created_text = format!(
                    "CREATE_PREVIEW_START\n{}CREATE_PREVIEW_TAIL",
                    "created line\n".repeat(599)
                );
                let pathological_delete = format!(
                    "DELETE_PREVIEW_START\n{}DELETE_PREVIEW_TAIL",
                    "deleted line\n".repeat(20_000)
                );
                let mut s = tool_span(
                    "edit-create-safe-1", "edit", "Large file creation", Some("Exercise exact one-sided creation counts"),
                    serde_json::json!({
                        "path": "src/created.ts",
                        "edits": [{ "oldText": "", "newText": created_text }]
                    }),
                    true,
                    serde_json::json!("large file created"),
                    0, 0, 1,
                );
                s.extend(tool_span(
                    "edit-delete-guarded-1", "edit", "Pathological file deletion", Some("Exercise guarded one-sided deletion counts"),
                    serde_json::json!({
                        "path": "src/deleted.ts",
                        "edits": [{ "oldText": pathological_delete, "newText": "" }]
                    }),
                    true,
                    serde_json::json!("large file deleted"),
                    0, 0, 1,
                ));
                s
            }
            // ── Compat ─────────────────────────────────────────────────────
            "compat" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::ExtensionCompatibilityIssue { base: base(), issue: ExtensionCompatibilityIssue {
                    capability: "custom".into(),
                    classification: ExtensionIssueClassification::TerminalOnly,
                    message: "Custom UI is not available in the pantoken remote; run the agent in a terminal for this workflow.".into(),
                    extension_path: Some("~/.pi/agent/extensions/fancy-tui.ts".into()),
                    event_name: Some("session_start".into()),
                } } },
            ],
            // ── Extension nudge ──────────────────────────────────────────
            "inject" => {
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "u-jn-1".into(), text: "Rename the helper and update its callers.".into(), images: None, entry_id: None, references: None } },
                ];
                advance_ts(12_000);
                for chunk in deltas("I'll rename it and fix the call sites. Let me find them first.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("jn-t1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "rg -n \"oldHelper\" src"}),
                    true,
                    serde_json::json!("src/a.ts:4:  oldHelper()\nsrc/b.ts:9:  oldHelper()"),
                    100, 200, 380));
                for chunk in deltas("Done — renamed `oldHelper` to `resolveHelper` and updated both call sites in `a.ts` and `b.ts`.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                advance_ts(400);
                s.push(ScriptStep { wait_ms: 120, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } });
                s.push(ScriptStep { wait_ms: 0, event: SessionDriverEvent::CustomMessage { base: base(), id: "inject-1".into(), custom_type: "extension-nudge".into(), text: "<extension-nudge>Review this turn's work for any follow-up needed.</extension-nudge>".into(), display: true, turn_boundary: false } });
                advance_ts(2_000);
                s.extend(tool_span("inj-t2", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "./scripts/check-followups \"prefer X over Y\""}),
                    true,
                    serde_json::json!("followup note staged"),
                    120, 220, 520));
                for chunk in deltas("Reviewed the turn and staged a followup note.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            // ── Skill load ────────────────────────────────────────────────
            "skill" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Something's off with the fold reducer — can you dig in?".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("This calls for the debug skill — let me load it, then trace the reducer.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("sk1", "read", "read", None, serde_json::json!({"path": ".pi/skills/debug/SKILL.md"}), true, serde_json::json!("# debug\nTrace the code path end-to-end before forming a hypothesis…"), 40, 90, 180));
                s.extend(tool_span("sk2", "read", "read", None, serde_json::json!({"path": "protocol/src/state.ts"}), true, serde_json::json!("// foldEvent — mutates state, returns it"), 40, 90, 180));
                s.extend(tool_span("sk3", "bash", "bash", None, serde_json::json!({"command": "bun test protocol/src/state.test.ts"}), true, serde_json::json!("✓ 12 pass\n0 fail"), 40, 90, 180));
                for chunk in deltas("The reducer is fine; the stray caret came from a missed assistant close. Fixing that.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            // ── Answer card ────────────────────────────────────────────────
            "answercard" => {
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "ac-u1".into(), text: "Strip the unused dep and regenerate the lockfile.".into(), images: None, entry_id: Some("e-ac-u1".into()), references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me check what's currently declared first.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("ac-t0", "read", "Read file", Some("Read a file from the workspace"),
                    serde_json::json!({"path": "server/package.json"}),
                    true, serde_json::json!("\"unused-pkg\": \"^1.2.3\""), 80, 180, 600));
                s.extend(tool_span("ac-t1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "rg -n \"unused-pkg\" server/package.json"}),
                    true, serde_json::json!("\"unused-pkg\": \"^1.2.3\""), 120, 220, 900));
                s.extend(tool_span("ac-t2", "answer", "Ask the operator", Some("Ask one or more multiple-choice questions"),
                    serde_json::json!({"questions": [{"question": "How do you want to proceed with removing the unused-pkg dependency?"}]}),
                    true,
                    serde_json::json!("Q: How do you want to proceed with removing the unused-pkg dependency?\n> The dep is declared in server/package.json and pulled transitively elsewhere; removing it needs the manifest edit + a lockfile regenerate.\nA: Drop the line from server/package.json, then run bun install to regenerate the lockfile, then run the full gate and commit"),
                    120, 220, 0));
                for chunk in deltas("Removed the line from server/package.json. Regenerating the lockfile.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("ac-t3", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun install 2>&1 | tail -4"}),
                    true, serde_json::json!("lockfile regenerated, no transitive holdouts ✓"), 120, 220, 830));
                s.extend(tool_span("ac-t4", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun test"}),
                    true, serde_json::json!("all tests pass"), 80, 180, 600));
                for chunk in deltas("Done — dep dropped, lockfile regenerated, the gate is green.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: Some("e-ac-u1".into()), assistant_entry_id: Some("e-ac-a1".into()) } });
                s
            }
            // ── Answer lead-up card ────────────────────────────────────────
            "answerleadup" => {
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "alu-u1".into(), text: "Ship the dep removal. Anything I should decide before you commit?".into(), images: None, entry_id: Some("e-alu-u1".into()), references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me check what's currently declared first.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("alu-t1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "rg -n \"unused-pkg\" server/package.json"}),
                    true, serde_json::json!("\"unused-pkg\": \"^1.2.3\""), 120, 220, 900));
                s.extend(tool_span("alu-t1b", "read", "Read file", Some("Read a file from the workspace"),
                    serde_json::json!({"path": "bunfig.toml"}),
                    true, serde_json::json!("# bunfig"), 80, 180, 500));
                for chunk in deltas("The removal is straightforward, but there's one call to make: the dep is also pulled transitively by a dev-only package, so I can either drop the manifest line and let the transitive copy resolve on its own, or pin an explicit override so the transitive copy disappears too. Dropping is faster but leaves the transitive copy; pinning is cleaner but needs a bunfig override. How do you want to proceed?", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("alu-t2", "answer", "Ask the operator", Some("Ask one or more multiple-choice questions"),
                    serde_json::json!({"questions": [{"question": "How do you want to handle the transitive copy of unused-pkg?", "options": [{"label": "Drop the manifest line only"}, {"label": "Drop + pin a bunfig override"}]}]}),
                    true,
                    serde_json::json!("Q: How do you want to handle the transitive copy of unused-pkg?\nOptions:\n  [x] Drop the manifest line only\n  [ ] Drop + pin a bunfig override\nA: Drop the manifest line only"),
                    120, 220, 0));
                for chunk in deltas("Dropping the manifest line and regenerating now.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("alu-t3", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun install 2>&1 | tail -4"}),
                    true, serde_json::json!("lockfile regenerated, transitive copy resolves ✓"), 120, 220, 830));
                s.extend(tool_span("alu-t3b", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun test"}),
                    true, serde_json::json!("all tests pass"), 80, 180, 500));
                for chunk in deltas("Done — dep dropped, lockfile regenerated, the gate is green.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: Some("e-alu-u1".into()), assistant_entry_id: Some("e-alu-a1".into()) } });
                s
            }
            // ── Additional scripts ────────────────────────────────────────
            "selectmany" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Select {
                    request_id: "req-select-many-1".into(),
                    title: "Which environment should I deploy to?".into(),
                    options: vec!["staging".into(), "production".into(), "canary".into()],
                    allow_multiple: None,
                    timeout_ms: None,
                } } },
            ],
            "planhandoff" => vec![
                plan_request(
                    "req-plan-handoff-1",
                    "Plan handoff",
                    PLAN_HANDOFF_TEXT,
                    Some("Daemon refuse option (Tab for feedback)"),
                    None,
                ),
            ],
            "planhandofftimeout" => vec![
                plan_request(
                    "req-plan-handoff-timeout-1",
                    "Plan handoff (timed)",
                    "# Timed plan\n\nThis short plan auto-dismisses after a drafted refusal.",
                    Some("Daemon refuse option (Tab for feedback)"),
                    Some(1200),
                ),
            ],
            "planhandofflegacy" => vec![
                plan_request(
                    "req-plan-handoff-legacy-1",
                    "Plan handoff (legacy daemon)",
                    PLAN_HANDOFF_TEXT,
                    None,
                    None,
                ),
            ],
            "planhandoffequal" => vec![
                plan_request(
                    "req-plan-handoff-equal-1",
                    "Plan handoff (equal labels)",
                    "# Equal-label plan\n\nThe refusal label intentionally equals Cancel.",
                    Some("Cancel"),
                    Some(1800),
                ),
            ],
            "planhandoffcollision" => vec![
                plan_request(
                    "req-plan-handoff-collision-1",
                    "Plan handoff (collision)",
                    "# Collision plan\n\nThe refusal label intentionally collides with an implementation label.",
                    Some("Implement (current context)"),
                    None,
                ),
            ],
            "planhandoffpending" => vec![
                plan_request(
                    "req-plan-handoff-pending-a",
                    "Plan handoff (pending A)",
                    PLAN_HANDOFF_TEXT,
                    Some("Daemon refuse option (Tab for feedback)"),
                    None,
                ),
                ScriptStep { wait_ms: 80, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Plan {
                    request_id: "req-plan-handoff-pending-b".into(),
                    title: "Plan handoff (pending B)".into(),
                    plan_text: "# Pending plan B\n\nA second request remains pending while the first is navigated away from.".into(),
                    display_path: Some("plan-b.md".into()),
                    target_facet: Some("execute".into()),
                    action_labels: ["Implement (new context)".into(), "Implement (current context)".into(), "Cancel".into()],
                    refuse_label: Some("Daemon refuse option (Tab for feedback)".into()),
                    timeout_ms: None,
                } } },
                ScriptStep { wait_ms: 5000, event: SessionDriverEvent::HostUiResolved {
                    base: base(),
                    request_id: "req-plan-handoff-pending-a".into(),
                } },
                // Resolve B in the same deterministic replacement tick so the new
                // request becomes the visible current card rather than remaining
                // behind another still-pending request.
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiResolved {
                    base: base(),
                    request_id: "req-plan-handoff-pending-b".into(),
                } },
                plan_request(
                    "req-plan-handoff-pending-replacement",
                    "Plan handoff (replacement)",
                    "# Replacement plan\n\nThe original pending request was resolved remotely.",
                    Some("Daemon refuse option (Tab for feedback)"),
                    None,
                ),
            ],
            "planfacet" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(SessionStatus::Idle, Some("plan".into()), None, None, None, None) } },
                // Explicitly clear activePlan when leaving the plan facet. Omitting the
                // field preserves it under the protocol's overwrite-guard semantics and
                // cannot exercise the stale PlanView toggle regression.
                ScriptStep { wait_ms: 1500, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(SessionStatus::Idle, Some("execute".into()), None, Some(String::new()), None, None) } },
            ],
            "permission" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Permission {
                    request_id: "req-permission-1".into(),
                    title: "Run bash?".into(),
                    tool_name: Some("shell_exec".into()),
                    tool_input: Some(serde_json::to_string_pretty(&serde_json::json!({"command": "rm -rf /tmp/test"})).unwrap_or_default()),
                    options: vec!["Deny".into(), "Allow once".into(), "Allow for session".into()],
                    timeout_ms: None,
                } } },
            ],
            "reset" => {
                let u_id = format!("u-reset-{}", ts());
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionReset { base: base() } },
                    ScriptStep { wait_ms: 20, event: SessionDriverEvent::UserMessage { base: base(), id: u_id.clone(), text: "Replayed prompt after the reset.".into(), images: None, entry_id: Some(format!("e-{u_id}")), references: None } },
                ];
                for chunk in deltas("Transcript rebuilt from daemon history after a reset.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 40, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: Some(format!("e-{u_id}")), assistant_entry_id: Some(format!("e-a-{u_id}")) } });
                s
            }
            "images" => {
                let call_id = format!("img-{}", ts());
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Here's the current screen — can you mock up a cleaner layout?".into(), images: Some(vec![ImageContent::Image { data: SHOT_PNG_B64.into(), mime_type: "image/png".into() }]), entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Sure — let me render a quick mockup and show it to you.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                // Tool span with image output — built manually (tool_span doesn't support images).
                s.push(ScriptStep { wait_ms: 140, event: SessionDriverEvent::ToolStarted {
                    base: base(), call_id: call_id.clone(), tool_name: "render_mockup".into(),
                    label: Some("Render mockup".into()),
                    description: Some("Render a UI mockup to a PNG and return it".into()),
                    input: Some(serde_json::json!({"spec": "two-column layout, sticky header"})),
                } });
                advance_ts(900);
                s.push(ScriptStep { wait_ms: 320, event: SessionDriverEvent::ToolFinished {
                    base: base(), call_id, success: true,
                    output: Some(serde_json::json!({"content": [{"type": "text", "text": "Rendered mockup (160×100 PNG)."}]})),
                    images: Some(vec![ImageContent::Image { data: MOCKUP_PNG_B64.into(), mime_type: "image/png".into() }]),
                    interrupted: None,
                } });
                for chunk in deltas("Here's the mockup — a two-column layout with a sticky header. Want me to wire it up?", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 80, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "longoutput" => {
                let log: String = (1..=40).map(|i| format!("[{:02}] test/case-{}.spec.ts … ok ({}ms)", i, i, i * 3)).collect::<Vec<_>>().join("\n");
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Run the test suite and show me the output.".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Running the suite now.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("long-1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun test --reporter=verbose"}),
                    true, serde_json::json!(format!("{log}\n\n40 pass, 0 fail")),
                    120, 200, 620));
                // Second tool span (≥2 threshold needs 2 tools to collapse).
                s.extend(tool_span("long-2", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun run check"}),
                    true, serde_json::json!("0 errors, 0 warnings"),
                    80, 180, 500));
                for chunk in deltas("All 40 cases passed.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 80, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "longthinking" => {
                // Long thinking block that overflows ~50% of the viewport when expanded —
                // exercises the CollapseFooter chevron. Includes a tool call so the turn
                // is collapsible (groupTurns requires ≥2 work tools). Fewer paragraphs with
                // larger chunks so the script settles quickly while still overflowing.
                let thinking: String = (1..=20).map(|i| format!("Paragraph {i}: This is a longer line of thinking reasoning text to ensure the block overflows the viewport height threshold when expanded, covering the analysis of step {i} in the overall plan.\n")).collect::<Vec<_>>().join("");
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Think through this carefully.".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me investigate first.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("lt-1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "echo thinking"}),
                    true, serde_json::json!("ok"), 40, 90, 180));
                // Second tool span (≥2 threshold needs 2 tools to collapse).
                s.extend(tool_span("lt-2", "read", "Read file", Some("Read a file from the workspace"),
                    serde_json::json!({"path": "README.md"}),
                    true, serde_json::json!("# Project\nA coding agent GUI."), 40, 90, 180));
                // Stream the thinking in 3 large chunks (fast settle).
                for chunk in deltas(&thinking, 50) {
                    s.push(ScriptStep { wait_ms: 10, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                for chunk in deltas("After all that consideration, the answer is straightforward.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 80, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "markdown" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Show me a markdown formatting sample.".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas(MARKDOWN_SAMPLE, 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "search" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Where is the WebSocket reconnect logic?".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me poke around the codebase a few ways.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                for (cid, name, input, output) in [
                    ("r1", "read", serde_json::json!({"path": "client/src/lib/store.svelte.ts"}), serde_json::json!("// store.svelte.ts\n  private reconnect() { /* WS singleton backoff */ }")),
                    ("r2", "read", serde_json::json!({"path": "client/src/App.svelte"}), serde_json::json!("// App.svelte — mounts the store and the transcript")),
                    ("g1", "grep", serde_json::json!({"pattern": "reconnect", "path": "client/src"}), serde_json::json!("client/src/lib/store.svelte.ts:88:  private reconnect() {")),
                    ("g2", "grep", serde_json::json!({"pattern": "WebSocket", "path": "client/src"}), serde_json::json!("client/src/lib/store.svelte.ts:31:    this.ws = new WebSocket(url);")),
                    ("f1", "find", serde_json::json!({"pattern": "*.svelte", "path": "client/src/components"}), serde_json::json!("client/src/components/Transcript.svelte\nclient/src/components/ToolCard.svelte")),
                    ("b1", "bash", serde_json::json!({"command": "rg -n \"reconnect\" client/src/lib"}), serde_json::json!("client/src/lib/store.svelte.ts:88:  private reconnect() {")),
                ] {
                    s.extend(tool_span(cid, name, name, Some(&format!("Run {name}")), input, true, output, 40, 90, 180));
                }
                for chunk in deltas("Reconnect lives in the store's WS singleton.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "thinkingtools" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Trace the reconnect path and check it end-to-end.".into(), images: None, entry_id: None, references: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                let c1 = format!("tbt-1-{}", ts());
                s.extend(tool_span(&c1, "bash", "bash", Some("Run bash"), serde_json::json!({"command": "ls client/src/lib"}), true, serde_json::json!("store.svelte.ts\nws.ts"), 40, 90, 180));
                for chunk in deltas("That lists the lib dir. The WS singleton is the likely home.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                let c2 = format!("tbt-2-{}", ts());
                s.extend(tool_span(&c2, "bash", "bash", Some("Run bash"), serde_json::json!({"command": "rg -n reconnect client/src"}), true, serde_json::json!("ws.ts:88: scheduleReconnect()"), 40, 90, 180));
                for chunk in deltas("Found the scheduler. Let me read the file to confirm the backoff.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                let c3 = format!("tbt-3-{}", ts());
                s.extend(tool_span(&c3, "read", "read", Some("Run read"), serde_json::json!({"path": "client/src/lib/ws.ts"}), true, serde_json::json!("// reconnecting WS singleton"), 40, 90, 180));
                for chunk in deltas("Backoff looks right. One more check on the call site.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                let c4 = format!("tbt-4-{}", ts());
                s.extend(tool_span(&c4, "bash", "bash", Some("Run bash"), serde_json::json!({"command": "rg -n scheduleReconnect client/src"}), true, serde_json::json!("ws.ts:88\nws.ts:142"), 40, 90, 180));
                for chunk in deltas("Reconnect is wired correctly — exponential backoff, capped, re-armed on close.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "streamhold" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Working on it — this turn stays open for the test.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s
            }
            "contextfull" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::UsageUpdated { base: base(), usage: mock_usage_full() } },
            ],
            "contextover" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::UsageUpdated { base: base(), usage: mock_usage_over_window() } },
            ],
            // ── Non-script controls (return early, no play_script) ─────────
            "queue" => {
                self.queues.lock().insert(
                    SESSION_ID.into(),
                    vec![
                        SessionQueuedMessage {
                            id: "queue-steer-fixture".into(),
                            mode: SessionMessageDeliveryMode::Steer,
                            text: "Please inspect the failing test first.".into(),
                            created_at: "queue-1".into(),
                            updated_at: "queue-1".into(),
                            references: None,
                        },
                        SessionQueuedMessage {
                            id: "queue-followup-fixture".into(),
                            mode: SessionMessageDeliveryMode::FollowUp,
                            text: "Then summarize the fix and remaining risks.".into(),
                            created_at: "queue-2".into(),
                            updated_at: "queue-2".into(),
                            references: None,
                        },
                    ],
                );
                self.emit_queue(SESSION_ID);
                return;
            }
            "deliverqueue" => {
                let next = {
                    let mut queues = self.queues.lock();
                    let queued = queues.entry(SESSION_ID.into()).or_default();
                    if queued.is_empty() {
                        None
                    } else {
                        Some(queued.remove(0))
                    }
                };
                if let Some(message) = next {
                    self.emit(SessionDriverEvent::QueuedMessageStarted {
                        base: base(),
                        message,
                    });
                    self.emit_queue(SESSION_ID);
                }
                return;
            }
            "discardqueue" => {
                // Mirrors the daemon's `PendingTurnInputDiscarded { missing_references }`
                // path: a queued steer/follow-up gets dropped because an `@`-reference it
                // named couldn't be resolved. Pops the queue head like "deliverqueue"
                // does, but emits the visible missing-refs warning instead of promoting
                // it into the turn — same `notify` mechanism + wording the real driver's
                // event_map uses (event_map::format_missing_references_message), so e2e
                // exercises the identical rendering path deterministically.
                let dropped = {
                    let mut queues = self.queues.lock();
                    let queued = queues.entry(SESSION_ID.into()).or_default();
                    if queued.is_empty() {
                        None
                    } else {
                        Some(queued.remove(0))
                    }
                };
                if dropped.is_some() {
                    let missing = [("skill", "ghost-skill"), ("file", "ghost-file.md")];
                    let message = crate::polytoken::event_map::format_missing_references_message(
                        missing.iter().copied(),
                    );
                    self.emit(SessionDriverEvent::HostUiRequest {
                        base: base(),
                        request: HostUiRequest::Notify {
                            request_id: format!("discard-missing-refs-{}", ts()),
                            message,
                            level: Some(NotifyLevel::Warning),
                        },
                    });
                    self.emit_queue(SESSION_ID);
                }
                return;
            }
            "failnewsession" => {
                self.fail_next_new_session.store(true, Ordering::SeqCst);
                return;
            }
            "failsession" => {
                // Arm a one-shot openSession() 409 lease-conflict (consumed by the
                // next switch). Faithful port of TS `runScript("failsession")`
                // (mock-driver.ts:982-985).
                self.fail_next_session.store(true, Ordering::SeqCst);
                return;
            }
            "jobs" => {
                // Swap the job fixtures so e2e can test the client-side refresh
                // path (FetchJobs → JobsList → UI updates).
                let mut jobs = self.jobs.lock();
                jobs.clear();
                jobs.push(BackgroundJob {
                    handle: "general-purpose:new-job".into(),
                    kind: JobKind::Subagent,
                    status: JobStatusKind::Running,
                    tool_name: "subagent".into(),
                    created_at: "2025-07-09T11:00:00Z".into(),
                    started_at: Some("2025-07-09T11:00:01Z".into()),
                    ended_at: None,
                    updated_at: "2025-07-09T11:01:00Z".into(),
                    subagent_type: Some("general-purpose".into()),
                    model: None,
                    subagent_handle: Some("general-purpose:new-job".into()),
                    expiring: None,
                    output_tail: Some("Investigating the codebase...\nReading protocol types".into()),
                    output_bytes: Some(256),
                });
                return;
            }
            // Simulate a session arriving externally (e.g. the daemon creates one
            // out-of-band) WITHOUT emitting a SessionDriverEvent — emitting would set
            // `session_list_dirty` and trigger a live-refresh rebroadcast, so only a
            // client-side `listSessions` poll surfaces the new row.
            "newsession" => {
                let mut sessions = self.sessions.lock();
                if !sessions
                    .iter()
                    .any(|s| s.session_id == "external-session".into())
                {
                    sessions.insert(0, SessionListEntry {
                        display_name: Some("External session".into()),
                        ..new_session_entry("external-session", WORKSPACE_PATH)
                    });
                }
                return;
            }
            _ => {
                warn!("[mock] run_script: {name} (not yet implemented)");
                return;
            }
        };
        self.play_script(steps);
    }

    fn reset(&self, _bootstrap: bool) {
        // Cancel all pending script tasks/dialogs + reset the mock clock so fixture
        // timestamps are deterministic across resets.
        self.cancel_timers();
        reset_ts();
        *self.last_created.lock() = None;
        self.fail_next_new_session.store(false, Ordering::SeqCst);
        self.fail_next_session.store(false, Ordering::SeqCst);
        self.abort_delay_ms.store(0, Ordering::SeqCst);
        self.new_session_seed_delay_ms.store(0, Ordering::SeqCst);
        self.abort_settle_delay_ms.store(0, Ordering::SeqCst);
        // Each test's first drive keeps the fixture's stable request ids.
        self.script_run.store(0, Ordering::SeqCst);
        *self.adventurous_handoff.lock().unwrap() = false;
        *self.goal.lock().unwrap() = None;
        // Restore the mutable session state to the fixture baseline —
        // faithful port of TS `reset()`: `this.sessions = SESSION_LIST.map(...)`.
        // Without this, a `new_session`-created row survives `/debug/reset`
        // and leaks into the next test's sidebar.
        *self.sessions.lock() = mock_session_list();
        *self.config.lock() = mock_default_config();
        *self.jobs.lock() = mock_default_jobs();
        *self.todos.lock() = mock_default_todos();
        self.queues.lock().clear();
        self.warm_sessions.lock().clear();
        self.accepted_prompts.lock().clear();
        self.live_config_actions.lock().clear();
        self.empty_default.lock().clear();
    }

    fn has_warm_session(&self, sid: &SessionId) -> bool {
        self.warm_sessions.lock().contains(sid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_step(id: &str) -> ScriptStep {
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::HostUiRequest {
                base: base(),
                request: HostUiRequest::Plan {
                    request_id: id.into(),
                    title: "Plan handoff".into(),
                    plan_text: "# Plan".into(),
                    display_path: None,
                    target_facet: None,
                    action_labels: [
                        "Implement (new context)".into(),
                        "Implement (current context)".into(),
                        "Cancel".into(),
                    ],
                    refuse_label: None,
                    timeout_ms: None,
                },
            },
        }
    }

    async fn next_dialog_id(rx: &mut mpsc::Receiver<SessionDriverEvent>) -> Option<String> {
        while let Some(ev) = rx.recv().await {
            if let SessionDriverEvent::HostUiRequest { request, .. } = ev {
                if is_dialog_request(&request) {
                    return Some(request_id_of(&request).to_string());
                }
            }
        }
        None
    }

    /// Re-driving the same fixture must produce disjoint dialog request ids —
    /// the client derives transcript notice ids (`resolved-{id}`,
    /// `response-summary-{id}`) from them, and the keyed transcript drops
    /// duplicates. The first drive keeps its stable ids; later drives are
    /// suffixed. A respond_ui resolution must then target the rewritten id
    /// (the one a client would echo back), keeping the pending bookkeeping and
    /// the derived notice ids consistent.
    #[tokio::test]
    async fn replay_rewrites_dialog_request_ids() {
        let driver = MockDriver::new();
        let (tx, mut rx) = mpsc::channel(64);
        driver.subscribe(Box::new(move |ev| {
            let _ = tx.try_send(ev);
        }));

        driver.play_script(vec![plan_step("req-plan-handoff-1")]);
        driver.play_script(vec![plan_step("req-plan-handoff-1")]);

        let first = next_dialog_id(&mut rx).await;
        let second = next_dialog_id(&mut rx).await;
        assert_eq!(first.as_deref(), Some("req-plan-handoff-1"));
        assert_eq!(second.as_deref(), Some("req-plan-handoff-1-run1"));
        assert_ne!(first, second);

        // A response to the rewritten id resolves the pending dialog and emits
        // notices whose ids are disjoint from the first run's.
        driver.respond_ui(
            HostUiResponse::Cancelled {
                request_id: second.clone().unwrap(),
                cancelled: true,
            },
            None,
        );
        let mut resolved: Option<String> = None;
        let mut notice_ids: Vec<String> = Vec::new();
        // Collect exactly the response batch: one HostUiResolved + two notices.
        while resolved.is_none() || notice_ids.len() < 2 {
            let Some(ev) = rx.recv().await else { break };
            match ev {
                SessionDriverEvent::HostUiResolved { request_id, .. } => {
                    resolved = Some(request_id);
                }
                SessionDriverEvent::HostUiRequest { request, .. } => {
                    if let HostUiRequest::Notify { request_id, .. } = request {
                        notice_ids.push(request_id);
                    }
                }
                _ => {}
            }
        }
        assert_eq!(resolved.as_deref(), second.as_deref());
        assert!(
            notice_ids
                .iter()
                .any(|id| id == "resolved-req-plan-handoff-1-run1"),
            "expected a resolved-rewritten-id notice, got {notice_ids:?}"
        );
        assert!(
            notice_ids
                .iter()
                .any(|id| id == "response-summary-req-plan-handoff-1-run1"),
            "expected a response-summary-rewritten-id notice, got {notice_ids:?}"
        );
    }
}
