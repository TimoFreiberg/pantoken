<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  let open = $state(false);

  // The active session's title comes from the folded snapshot (authoritative).
  const label = $derived(
    store.session.ambient.title || store.session.title || "pilot",
  );

  function basename(p: string): string {
    const parts = p.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || p;
  }

  function toggle(): void {
    if (!open) store.refreshSessions(); // pull a fresh list when opening
    open = !open;
  }
  function pick(path: string): void {
    store.openSession(path);
    open = false;
  }
  function create(): void {
    store.newSession();
    open = false;
  }
</script>

<div class="picker">
  <button class="trigger" onclick={toggle} title="Switch session">
    <span class="label">{label}</span>
    <span class="chev" class:up={open}>▾</span>
  </button>

  {#if open}
    <button class="backdrop" aria-label="Close session list" onclick={() => (open = false)}
    ></button>
    <div class="panel">
      <div class="head">
        <span>Sessions</span>
        <button class="new" onclick={create}>+ New</button>
      </div>
      {#if store.sessions.length === 0}
        <div class="empty">No saved sessions yet.</div>
      {:else}
        <ul>
          {#each store.sessions as s (s.path)}
            <li>
              <button
                class="row"
                class:active={s.sessionId === store.activeSessionId}
                onclick={() => pick(s.path)}
              >
                <span class="name">{s.displayName || s.preview || "(untitled)"}</span>
                <span class="meta">{basename(s.cwd)} · {s.messageCount} msg</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    min-width: 0;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text);
  }
  .label {
    font-weight: 600;
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chev {
    color: var(--text-faint);
    font-size: 11px;
    transition: transform 0.12s ease;
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 40;
    cursor: default;
  }
  .panel {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 50;
    width: min(320px, 86vw);
    max-height: 60vh;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .new {
    text-transform: none;
    letter-spacing: 0;
    font-size: 12px;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 9px;
    cursor: pointer;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface-sunken);
  }
  .row.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .name {
    font-size: 13.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 11.5px;
    color: var(--text-faint);
    font-family: var(--font-mono);
  }
  .empty {
    padding: 16px 12px;
    font-size: 13px;
    color: var(--text-muted);
    text-align: center;
  }
</style>
