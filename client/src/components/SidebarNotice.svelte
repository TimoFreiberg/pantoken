<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import NoticeItem from "./NoticeItem.svelte";
</script>

{#if store.sidebarToasts.length > 0}
  <div
    class="sidebar-notice"
    role="region"
    aria-label="Sidebar notifications"
    data-testid="sidebar-notice"
  >
    {#each store.sidebarToasts as t (t.id)}
      <NoticeItem toast={t} onDismiss={(id) => store.dismissNotice("sidebar", id)} />
    {/each}
  </div>
{/if}

<style>
  .sidebar-notice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 10px;
    flex-shrink: 0;
  }
</style>
