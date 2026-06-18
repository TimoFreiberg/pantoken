<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  // Context-window fill for the active session, server-authoritative (folded from the
  // snapshot's `usage`; recomputed at turn boundaries + model switches). Undefined
  // until a snapshot carries it, or when the model exposes no context window.
  const usage = $derived(store.session.usage);
  // pct drives the ring; clamp the ARC to 100 (an overflow still reads the real % in
  // the label/tooltip). null tokens = window known but count pending (post-compaction).
  const pct = $derived(usage?.percent ?? null);
  const arc = $derived(pct === null ? 0 : Math.max(0, Math.min(100, pct)));
  const pctLabel = $derived(
    pct === null ? "—" : pct < 1 && pct > 0 ? "<1%" : `${Math.round(pct)}%`,
  );
  // Warm → hot as the window fills, so a nearly-full context is legible at a glance.
  const tone = $derived(arc >= 90 ? "danger" : arc >= 75 ? "warning" : "accent");

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
  const title = $derived.by(() => {
    if (!usage) return "Context window usage";
    const win = `${fmt(usage.contextWindow)} token window`;
    if (usage.tokens === null)
      return `Context size pending — recomputed after the next response · ${win}`;
    return `${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens in context · ${pctLabel} of the window`;
  });
</script>

{#if usage}
  <div class="meter {tone}" {title} data-testid="context-meter">
    <svg class="ring" viewBox="0 0 36 36" width="18" height="18" aria-hidden="true">
      <circle class="track" cx="18" cy="18" r="15.9155" />
      {#if arc > 0}
        <circle
          class="arc"
          cx="18"
          cy="18"
          r="15.9155"
          stroke-dasharray="{arc} 100"
          transform="rotate(-90 18 18)"
        />
      {/if}
    </svg>
    <span class="label">{pctLabel}</span>
  </div>
{/if}

<style>
  .meter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-sans);
    font-size: 12.5px;
    letter-spacing: -0.01em;
    color: var(--text-muted);
    /* Display-only — no pointer affordance; the tooltip carries the detail. */
    cursor: default;
    user-select: none;
  }
  .ring {
    flex-shrink: 0;
    overflow: visible;
  }
  .track {
    fill: none;
    stroke: var(--border-strong);
    stroke-width: 3.4;
  }
  .arc {
    fill: none;
    stroke-width: 3.4;
    stroke-linecap: round;
    transition: stroke-dasharray 0.3s ease, stroke 0.2s ease;
  }
  .accent .arc {
    stroke: var(--accent);
  }
  .warning .arc {
    stroke: var(--warning);
  }
  .danger .arc {
    stroke: var(--danger);
  }
  .warning .label {
    color: var(--warning);
  }
  .danger .label {
    color: var(--danger);
  }
  .label {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
</style>
