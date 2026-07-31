<script lang="ts">
  import type { SessionUsage } from "@pantoken/protocol";
  import { contextTone } from "../lib/context-tone.js";
  import { clampContextPercent } from "../lib/context-usage.js";

  // A color-coded context-window gauge: a fill ring + optional % label. Shared by the
  // composer meter and the sidebar rows so the scale + colors stay identical. The host
  // decides whether `usage` exists; this just renders the gauge for a given one.
  let {
    usage,
    size = 18,
    showLabel = true,
    testid,
  }: {
    usage: SessionUsage;
    size?: number;
    showLabel?: boolean;
    testid?: string;
  } = $props();

  // pct drives the ring; clamp both the arc and the label to 100 — the wire
  // percent can exceed 100 when used_tokens > limit_tokens (the server clamps in
  // usage_from_state, but the mock constructs SessionUsage directly and bypasses
  // that, so this client clamp is load-bearing). Null tokens = window known but
  // count pending (post-compaction).
  const clamped = $derived(clampContextPercent(usage.percent));
  const arc = $derived(clamped ?? 0);
  const pctLabel = $derived(
    clamped === null
      ? "—"
      : clamped < 1 && clamped > 0
        ? "<1%"
        : `${Math.round(clamped)}%`,
  );
  const tone = $derived(contextTone(clamped));

</script>

<div class="meter {tone}" data-testid={testid}>
  <svg
    class="ring"
    viewBox="0 0 36 36"
    width={size}
    height={size}
    aria-hidden="true"
  >
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
  {#if showLabel}
    <span class="label">{pctLabel}</span>
  {/if}
</div>

<style>
  .meter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-sans);
    font-size: 12.5px;
    letter-spacing: -0.01em;
    color: var(--text-muted);
    /* Display-only — the surrounding context menu carries the detail. */
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
    transition:
      stroke-dasharray 0.3s ease,
      stroke 0.2s ease;
  }
  .ok .arc {
    stroke: var(--ok);
  }
  .warning .arc {
    stroke: var(--warning);
  }
  .accent .arc {
    stroke: var(--accent);
  }
  .danger .arc {
    stroke: var(--danger);
  }
  /* Escalating attention: the label picks up the band color once it matters; the
     calm green stays muted so a healthy window doesn't shout. */
  .warning .label {
    color: var(--warning);
  }
  .accent .label {
    color: var(--accent);
  }
  .danger .label {
    color: var(--danger);
  }
  .label {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
</style>
