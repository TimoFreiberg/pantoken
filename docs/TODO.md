# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
See `docs/` siblings for context: `STATUS.md` (what's built), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

- [ ] **Interactive project-trust card** (D12) — surface a `hostUiRequest` trust
      card to connected clients and let them grant/deny (replaces the mock-only
      fixture). Open hurdles after the warm-session rework: (1) trust resolves
      inside `warmUp` during service creation (`createAgentSessionServices`'s
      `resolveProjectTrust`), which runs *before* that session's `PiUiBridge`
      exists — so there's no per-session channel to emit the card through yet; and
      (2) the hub still wraps `openSession`/`newSession` in `switchTo` under
      `switching = true`, which suppresses stray events mid-swap. NOTE: the
      auto-trust security hole is already closed by a non-interactive resolver
      (`server/src/pi/trust.ts` — honors trust.json, trusts the launch cwd, denies
      other untrusted paths), so this is now UX, not a safety blocker.

## 🟡 Important

- [ ] **Settings panel** — provider config, API keys, auth token, model
      defaults, theme toggle, notification prefs. Inspired by pi-gui's
      settings panel.

## 🟢 Polish / fast-follow

- [ ] **Suppress notifications when app focused** — if feasible, silence push/toast
      notifications while the browser tab/window has focus
- [ ] **Desktop notifications conflict with terminal pi extension** — on desktop
      browser, pilot's notification triggers the user's terminal pi notification
      extension (which links back to the terminal). Needs investigation: either
      suppress Web Notifications when pilot is the focused browser tab, or find a
      way to avoid double-firing through the extension.
- [ ] **Message timestamps** — small relative timestamp at the bottom of each
      agent and user text box (e.g. "5m ago"), with mouseover revealing the exact
      timestamp
- [ ] **Copy-to-clipboard button on agent messages** — a button at the bottom of
      each agent text area; hidden until hover, copies message content
- [ ] **Worktree checkbox in new-session form** — like the Claude app's "worktree"
      toggle; creates and passes a jj/git worktree path as the session cwd so the
      agent works in an isolated copy, leaving the main tree clean
- [ ] **Session context indicator** — a small color-coded circle (or similar badge)
      in the session list / header showing how much context the session has consumed,
      analogous to the Claude app's colored circle (green → yellow → red as the
      context window fills). Color could map to token-budget thresholds from the
      snapshot's `config`/usage fields; exact threshold values TBD
- [ ] **Stray caret span in agent text** — a naked `<span class="caret svelte-1rd1h7a"></span>`
      is appended to the end of agent output, looks like a client rendering bug.
      Needs investigation and fix

- [ ] **Jump-to-last-prompt hotkey** (OP8)
- [ ] **Type-to-focus prompt field** — basic typable characters focus the
      text field before typing them (or a dedicated hotkey)
- [ ] **Beautiful font rendering** — prose readability pass (OP8)
- [ ] **Tool card inspection polish** — unobtrusive expand/collapse (OP8)
- [ ] **Stray iOS zoom fix** — composer `font-size: ≥16px` to stop iOS
      auto-zoom; `overflow-x: hidden` on root
- [ ] **Live markdown rendering in prompt edit box** — preview formatting
      as you type, if straightforward
- [ ] **Slash-command autocompletion** + inline help text describing each
      command
- [ ] **PNG / maskable icons** — proper app icons for installed PWA
- [ ] **Virtualized transcript list** (>80 rows)
- [ ] **Binary 2-option select → Yes/No card**
- [ ] **Countdown for timeout-bearing dialogs**
- [ ] **Extensions enable/disable view** + compatibility-issue surfacing
- [ ] **Session rename / archive / unarchive** — from the sidebar (the create/open
      half landed; this is the remaining SHOULD from DESIGN's "Sessions & history")

## 🔵 Later

- [ ] **gondolin egress containment** (D10) — for the autonomous Mac Mini
      user account; preserves TS-embed via pi-gondolin extension
- [ ] **Session tree / fork / clone / compaction**
- [ ] **Scheduled / recurring runs**
- [ ] **Image / file attachments** (browser file input)
- [ ] **Inline tool-diff rendering**
- [ ] **Workspace git changed-files/diff/stage panel**
- [ ] **Skills enable/disable view**

- [ ] **Right-side session minimap** (nebulous, OP8)
- [ ] **Queued-messages editing** (replace queued)

---

## ✅ Done (for reference)

- [x] **Live pi bring-up** — first real turn against provider credentials.
      `PILOT_DRIVER=pi PILOT_CWD=/some/repo bun run dev`. Working; rough edges
      are filed as separate todos.
- [x] **Session/project sidebar** — replaced the header session dropdown
      (`SessionPicker` deleted) with a collapsible left rail (desktop) / slide-over
      drawer (mobile) that groups sessions by project directory. `listSessions` now
      spans every project (`SessionManager.listAll`), so it's a cross-project
      navigator. New sessions can target an arbitrary typed cwd (`newSession` carries
      `cwd` → `SessionManager.create`; `~`-expanded, resolved, rejects a non-directory
      loudly — the D12 GUI affordance), plus a per-project `+`. Switch errors surface
      in the sidebar. Open/collapse is per-client + localStorage-persisted. e2e-covered
      (`sessions.spec.ts`: grouping/switch, per-project `+`, arbitrary typed dir).
      (rename/archive/unarchive still open — see Polish.)
- [x] **Per-session model + thinking-level picker** — provider-grouped model menu +
      thinking-level menu in the header (`setModel`/`setThinking` over the wire,
      `modelList` broadcast; selection rides each session's snapshot `config`).
      e2e-covered (`models.spec.ts`).
- [x] **Multi-session — keep N warm** (D8 increment 2) — the pi-driver now holds a
      `Map<sessionId, WarmSession>` of fully-independent sessions instead of a
      single `AgentSessionRuntime` that disposed the old session on every switch.
      `openSession`/`newSession` warm-and-focus (create on first touch, dedup by
      session file and refocus after); `prompt`/`abort`/`respondUi` dispatch by
      `sessionId`; each session gets its own services (trust resolver per cwd), UI
      bridge, and subscription, all streaming into one `emit`. Nothing is disposed
      on a switch — a backgrounded session stays warm and is instantly re-focusable
      with full history. Verified live (`scripts/live-warm-toggle.ts`): open A →
      open B (`2 warm`) → re-open A returns A's transcript intact via the refocus
      path, no re-create, no stale-ctx crash. (No eviction cap yet — fast-follow.)
      Live background *streaming* across a focus-switch still awaits provider creds
      (the Live pi bring-up task) since it needs a real model turn.
- [x] **Multi-session hub** (D8 increment 1) — the hub tracks a focused session:
      folds + broadcasts only the focused one, routes `prompt`/`abort`/`respondUi`
      by `sessionId`; background sessions still notify a closed phone. Behavior
      unchanged for a single active session.
- [x] **Project-trust gate MVP** (D12) — non-interactive `resolveProjectTrust`
      (`server/src/pi/trust.ts`) closed a live auto-trust hole (pi auto-trusts
      every project unless the host resolves trust). Honors trust.json
      (parent-aware), trusts the launch cwd, denies other untrusted paths.
      Interactive card still open above.
- [x] **Persistence rework** (D13) — driver resumes via
      `SessionManager.continueRecent(cwd)`, discovers via `list`, switches via
      `runtime.switchSession`, rebuilds state from session files on load
      (`historyToEvents`). Verified live: resume-across-restart + new↔existing
      switching replay the full transcript. (Stale-ctx swap crash fixed en route.)
- [x] iOS Web Push spike (D11) — SW handlers, VAPID keypair + subscription
      store, server fan-out, header bell. Verified buzzing closed iPhone.
      Gotchas banked: `PILOT_VAPID_SUBJECT` must be real https/mailto.
- [x] M0–M5 built + green — mock driver, transcript/turn UI, approvals,
      multi-client, remote infra, real pi driver (typechecked, unit-tested),
      PWA, Playwright suite (19 specs, desktop + mobile)
- [x] Open questions resolved (OQ1–OQ8 → D7–D14) — TS-embed confirmed,
      no tool gating, multiple concurrent sessions, arbitrary paths,
      dark-first styling, etc.
