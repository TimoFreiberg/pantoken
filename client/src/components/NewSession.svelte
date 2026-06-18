<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  // The transcript-area hero for the new-session draft (store.draft != null). The
  // actual config chips + first-prompt input live in the Composer below; this just
  // frames the empty space and makes the deferred-creation contract explicit.
  const cwd = $derived(store.draft?.cwd?.trim() || "");
  const worktree = $derived(store.draft?.worktree ?? false);
</script>

<div class="hero" data-testid="new-session">
  <div class="inner">
    <div class="title">New session</div>
    <div class="sub">
      {#if cwd}
        in <code>{cwd}</code>{#if worktree} · isolated worktree{/if}
      {:else}
        in the launch directory{#if worktree} · isolated worktree{/if}
      {/if}
    </div>
    <div class="note">Nothing is created until you send your first message.</div>
    <button
      class="cancel"
      title="Discard this new session (Esc)"
      onclick={() => store.cancelDraft()}>Cancel</button
    >
  </div>
</div>

<style>
  .hero {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    text-align: center;
  }
  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-width: 440px;
  }
  .title {
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
  }
  .sub {
    font-size: 14px;
    color: var(--text-muted);
  }
  .sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 1px 5px;
    word-break: break-all;
  }
  .note {
    font-size: 12.5px;
    color: var(--text-faint);
    margin-top: 2px;
  }
  .cancel {
    margin-top: 10px;
    font-size: 12.5px;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 5px 16px;
    cursor: pointer;
  }
  .cancel:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
</style>
