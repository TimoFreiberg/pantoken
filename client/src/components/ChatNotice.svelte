<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import NoticeItem from "./NoticeItem.svelte";
</script>

{#if store.chatToasts.length > 0}
  <div
    class="chat-notice"
    role="region"
    aria-label="Chat notifications"
    data-testid="chat-notice"
  >
    {#each store.chatToasts as t (t.id)}
      <NoticeItem toast={t} onDismiss={(id) => store.dismissNotice("chat", id)} />
    {/each}
  </div>
{/if}

<style>
  .chat-notice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 12px;
    flex-shrink: 0;
  }
  .chat-notice :global(.notice) {
    border-radius: var(--radius-sm);
    box-shadow: none;
    border-color: var(--border);
  }
</style>
