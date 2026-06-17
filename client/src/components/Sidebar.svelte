<script lang="ts">
  import type { SessionListEntry } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";

  // A new-session-in-a-directory disclosure (D12: arbitrary GUI-controlled paths).
  let showNewDir = $state(false);
  let newDir = $state("");

  function basename(p: string): string {
    const parts = p.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || p;
  }

  // The cwd of the currently-active session, used to prefill the new-dir input so
  // "new session near where I am" is one keystroke, not a full path retype.
  const activeCwd = $derived(
    store.sessions.find((s) => s.sessionId === store.activeSessionId)?.cwd ?? "",
  );

  // Group sessions by project directory; sort sessions within a group and groups
  // themselves by recency (most recent first), so the active project floats up.
  const groups = $derived.by(() => {
    const m = new Map<string, SessionListEntry[]>();
    for (const s of store.sessions) {
      const arr = m.get(s.cwd);
      if (arr) arr.push(s);
      else m.set(s.cwd, [s]);
    }
    const out = [...m.entries()].map(([cwd, items]) => ({
      cwd,
      items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
    out.sort((a, b) =>
      (b.items[0]?.updatedAt ?? "").localeCompare(a.items[0]?.updatedAt ?? ""),
    );
    return out;
  });

  // Per-project collapse state, keyed by cwd. Empty = everything expanded.
  let collapsed = $state<Record<string, boolean>>({});
  function toggleGroup(cwd: string): void {
    collapsed = { ...collapsed, [cwd]: !collapsed[cwd] };
  }

  // Re-scan disk whenever the sidebar opens, so a session another client created
  // (or the agent itself) shows up without a reload.
  $effect(() => {
    if (store.sidebarOpen) store.refreshSessions();
  });

  function isPhone(): boolean {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 859px)").matches
    );
  }
  // On a phone the sidebar is an overlay drawer — close it after navigating so the
  // transcript is visible. On desktop it stays pinned open.
  function afterNavigate(): void {
    if (isPhone()) store.closeSidebar();
  }

  function pick(s: SessionListEntry): void {
    store.openSession(s.path);
    afterNavigate();
  }
  function newInDir(cwd: string): void {
    store.newSession(cwd);
    afterNavigate();
  }
  function openNewDir(): void {
    newDir = activeCwd;
    showNewDir = true;
  }
  function submitNewDir(): void {
    const dir = newDir.trim();
    if (!dir) return;
    store.newSession(dir);
    showNewDir = false;
    afterNavigate();
  }
</script>

<!-- Backdrop only matters on the phone overlay; harmless (transparent, behind) on desktop. -->
{#if store.sidebarOpen}
  <button
    class="scrim"
    aria-label="Close sidebar"
    onclick={() => store.closeSidebar()}
  ></button>
{/if}

<aside class="sidebar" data-testid="sidebar" data-open={store.sidebarOpen}>
  <div class="top">
    <span class="brand">pilot</span>
    <button
      class="icon"
      title="Collapse sidebar"
      aria-label="Collapse sidebar"
      onclick={() => store.closeSidebar()}
    >
      ‹
    </button>
  </div>

  <div class="new">
    {#if showNewDir}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          submitNewDir();
        }}
      >
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="dir-input"
          type="text"
          autofocus
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          placeholder="/absolute/path/to/project"
          bind:value={newDir}
          onkeydown={(e) => {
            if (e.key === "Escape") showNewDir = false;
          }}
        />
        <div class="dir-actions">
          <button class="ghost" type="button" onclick={() => (showNewDir = false)}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={!newDir.trim()}>
            Start
          </button>
        </div>
      </form>
    {:else}
      <button class="new-btn" onclick={openNewDir}>
        <span class="plus">+</span> New session in a directory…
      </button>
    {/if}
    {#if store.lastError}
      <div class="err" role="alert">
        {store.lastError}
        <button class="err-x" aria-label="Dismiss" onclick={() => store.clearError()}
          >×</button
        >
      </div>
    {/if}
  </div>

  <nav class="list">
    {#if groups.length === 0}
      <div class="empty">No sessions yet.</div>
    {:else}
      {#each groups as g (g.cwd)}
        <section class="group">
          <div class="group-head">
            <button
              class="group-toggle"
              title={g.cwd}
              onclick={() => toggleGroup(g.cwd)}
            >
              <span class="caret" class:collapsed={collapsed[g.cwd]}>▾</span>
              <span class="proj">{basename(g.cwd)}</span>
              <span class="count">{g.items.length}</span>
            </button>
            <button
              class="icon add"
              title={`New session in ${g.cwd}`}
              aria-label={`New session in ${basename(g.cwd)}`}
              onclick={() => newInDir(g.cwd)}>+</button
            >
          </div>
          {#if !collapsed[g.cwd]}
            <ul>
              {#each g.items as s (s.path)}
                <li>
                  <button
                    class="row"
                    class:active={s.sessionId === store.activeSessionId}
                    onclick={() => pick(s)}
                  >
                    <span class="name"
                      >{s.displayName || s.preview || "(untitled)"}</span
                    >
                    <span class="meta">{s.messageCount} msg</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </nav>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 264px;
    flex-shrink: 0;
    height: 100%;
    height: 100dvh;
    background: var(--surface-sunken);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  /* Collapsed on desktop: removed from the flex flow entirely. */
  .sidebar[data-open="false"] {
    display: none;
  }
  .scrim {
    display: none;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
  }
  .brand {
    font-weight: 650;
    font-size: 15px;
    letter-spacing: 0.01em;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    font-size: 17px;
    line-height: 1;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
  }
  .icon:hover {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }

  .new {
    padding: 0 10px 8px;
  }
  .new-btn {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    text-align: left;
    font-size: 13px;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .new-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .plus {
    color: var(--accent);
    font-weight: 700;
  }
  .dir-input {
    width: 100%;
    font-family: var(--font-mono);
    font-size: 13px; /* ≥16px would dodge iOS zoom, but this input only shows on desktop-ish widths; keep compact */
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .dir-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .dir-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  .ghost,
  .primary {
    font-size: 12.5px;
    border-radius: var(--radius-xs);
    padding: 5px 11px;
    border: 1px solid var(--border);
  }
  .ghost {
    color: var(--text-muted);
    background: transparent;
  }
  .primary {
    color: var(--accent-text);
    background: var(--accent);
    border-color: var(--accent);
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .err {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--danger);
    background: var(--danger-soft);
    border-radius: var(--radius-xs);
    padding: 6px 8px;
  }
  .err-x {
    margin-left: auto;
    background: transparent;
    border: none;
    color: var(--danger);
    font-size: 14px;
    line-height: 1;
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 6px 14px;
  }
  .empty {
    padding: 16px 10px;
    font-size: 13px;
    color: var(--text-muted);
    text-align: center;
  }
  .group {
    margin-bottom: 2px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
  }
  .group-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 7px 6px;
    color: var(--text-muted);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .caret {
    font-size: 10px;
    color: var(--text-faint);
    transition: transform 0.12s ease;
  }
  .caret.collapsed {
    transform: rotate(-90deg);
  }
  .proj {
    font-weight: 600;
    color: var(--text);
    text-transform: none;
    letter-spacing: 0;
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    color: var(--text-faint);
    font-size: 11px;
  }
  .add {
    width: 24px;
    height: 24px;
    font-size: 15px;
    flex-shrink: 0;
  }
  ul {
    list-style: none;
    margin: 0 0 2px;
    padding: 0;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 10px 7px 18px;
  }
  .row:hover {
    background: var(--surface);
  }
  .row.active {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .name {
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.active .name {
    color: var(--accent);
    font-weight: 550;
  }
  .meta {
    font-size: 11px;
    color: var(--text-faint);
    font-family: var(--font-mono);
  }

  /* Phone: the sidebar becomes a slide-over drawer above the transcript. */
  @media (max-width: 859px) {
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 60;
      width: min(82vw, 320px);
      box-shadow: var(--shadow-pop);
      transition: transform 0.18s ease;
    }
    .sidebar[data-open="false"] {
      display: flex; /* keep it mounted; slide it off-screen instead of unmounting */
      transform: translateX(-100%);
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 55;
      background: rgba(0, 0, 0, 0.34);
      border: none;
    }
  }
</style>
