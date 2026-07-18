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
  /* Overlay: anchored to the sidebar (which is position: relative on desktop,
     position: fixed on mobile — both establish a containing block). Sits below
     the header so it doesn't cover the "New session" / filter controls, and
     pointer-events: none on the container lets clicks pass through to rows
     beneath the gaps while each toast remains clickable. This keeps the notice
     from participating in the sidebar's flex flow, so session rows and the
     "New session" button don't shift when a notice appears (AC.1). */
  .sidebar-notice {
    position: absolute;
    top: calc(var(--header-h) + env(safe-area-inset-top) + 8px);
    left: 10px;
    right: 10px;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 6px;
    pointer-events: none;
  }
  .sidebar-notice :global(.notice) {
    pointer-events: auto;
  }
  /* Mobile: the sidebar's .top bar is 52px (not the 64px --header-h), so sit
     flush below the mobile header. The sidebar is position: fixed here, which
     still anchors an absolute child correctly. */
  @media (max-width: 859px) {
    .sidebar-notice {
      top: calc(52px + env(safe-area-inset-top) + 8px);
    }
  }
</style>
