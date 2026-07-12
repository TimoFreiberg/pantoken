<script lang="ts">
  import { onDestroy } from "svelte";
  import { store } from "../lib/store.svelte.js";
  import ContextRing from "./ContextRing.svelte";
  import { contextTone } from "../lib/context-tone.js";

  // Context-window fill for the active session, server-authoritative (folded from the
  // snapshot's `usage`; recomputed at turn boundaries + model switches). Undefined
  // until a snapshot carries it, or when the model exposes no context window.
  const usage = $derived(store.session.usage);

  // Hover (desktop) or tap (touch) opens the detail popup. `pinned` stays open
  // when the pointer leaves so touch users can reach the buttons. Mirrors
  // TaskList.svelte's hover/pin pattern.
  let hovered = $state(false);
  let pinned = $state(false);
  const open = $derived(hovered || pinned);

  // Click-twice confirm gates for the two destructive buttons. Each has its own
  // armed state + 3s timer (mirrors Transcript.svelte's rewind gate). Arming one
  // disarms the other so the user can change their mind.
  const ARM_TIMEOUT = 3000;
  let armedCompact = $state(false);
  let armedClear = $state(false);
  let compactTimer: ReturnType<typeof setTimeout> | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  function confirmCompact(): void {
    if (armedCompact) {
      disarmCompact();
      store.compact();
      pinned = false;
    } else {
      disarmClear();
      armedCompact = true;
      compactTimer = setTimeout(disarmCompact, ARM_TIMEOUT);
    }
  }
  function confirmClear(): void {
    if (armedClear) {
      disarmClear();
      store.clearContext();
      pinned = false;
    } else {
      disarmCompact();
      armedClear = true;
      clearTimer = setTimeout(disarmClear, ARM_TIMEOUT);
    }
  }
  function disarmCompact(): void {
    armedCompact = false;
    if (compactTimer) {
      clearTimeout(compactTimer);
      compactTimer = null;
    }
  }
  function disarmClear(): void {
    armedClear = false;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
  }
  function disarm(): void {
    disarmCompact();
    disarmClear();
  }

  // Clean up arm timers on teardown (mirrors Transcript.svelte:38).
  onDestroy(() => disarm());

  function onCompactClick(): void {
    confirmCompact();
  }
  function onClearClick(): void {
    confirmClear();
  }

  const compactLabel = $derived(armedCompact ? "Click again" : "Compact");
  const clearLabel = $derived(armedClear ? "Click again" : "Clear context");
  const compactTitle = $derived(
    armedCompact ? "Click again to compact context" : "Compact context (summarize to free space)",
  );
  const clearTitle = $derived(
    armedClear ? "Click again to clear context" : "Clear all context (cannot be undone)",
  );

  // Reset armed state when the popup closes. A session switch may not close
  // the popup (both sessions can have usage), so the armed state persists
  // across switches until the 3s timer auto-disarms — acceptable given the
  // short window. The $effect only reads `open`, so disarm()'s writes to
  // armedCompact/armedClear don't create a dependency loop.
  $effect(() => {
    if (!open) disarm();
  });

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
  const tone = $derived(contextTone(usage?.percent ?? null));
  const barWidth = $derived(Math.min(100, usage?.percent ?? 0));
</script>

{#if usage}
  <div
    class="ctx-meter"
    role="group"
    aria-label="Context window controls"
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    onfocusin={() => (hovered = true)}
    onfocusout={() => (hovered = false)}
  >
    {#if open}
      <div class="pop">
        <div class="pop-card" data-testid="context-popup">
          <div class="pop-head">Context window</div>
          {#if usage.tokens === null}
            <div class="detail">Context size pending</div>
            <div class="detail">— recomputed after the next response</div>
            <div class="detail muted">{fmt(usage.contextWindow)} token window</div>
          {:else}
            <div class="detail">{fmt(usage.tokens)} / {fmt(usage.contextWindow)} tokens</div>
            <div class="bar {tone}">
              <div class="bar-fill" style="width: {barWidth}%"></div>
            </div>
            <div class="detail muted">{Math.round(usage.percent ?? 0)}% of window</div>
          {/if}
          <div class="actions">
            <button
              class="action {tone}"
              class:armed={armedCompact}
              data-testid="compact-btn"
              onclick={onCompactClick}
              title={compactTitle}
            >
              {compactLabel}
            </button>
            <button
              class="action danger"
              class:armed={armedClear}
              data-testid="clear-context-btn"
              onclick={onClearClick}
              title={clearTitle}
            >
              {clearLabel}
            </button>
          </div>
        </div>
      </div>
    {/if}

    <button
      class="trigger"
      data-testid="context-trigger"
      aria-label={usage.tokens === null
        ? "Context window usage details"
        : `Context window: ${Math.round(usage.percent ?? 0)}% used`}
      title="Show exact context window usage"
      aria-expanded={open}
      aria-haspopup="dialog"
      onclick={(e) => {
        // Only toggle pinned if the click landed on the trigger itself or the
        // ContextRing, not on a descendant action button.
        const target = e.target as HTMLElement;
        if (!target.closest(".action")) {
          pinned = !pinned;
        }
      }}
      onkeydown={(e) => {
        if (e.key === "Escape" && pinned) {
          e.preventDefault();
          pinned = false;
        }
      }}
    >
      <!-- data-testid stays on the inner ContextRing so existing e2e tests
           (context-meter.e2e.ts, live-updates.e2e.ts) keep matching the ring's
           .meter div and its computed title/label. -->
      <ContextRing {usage} testid="context-meter" showLabel={false} />
    </button>
  </div>
{/if}

<style>
  .ctx-meter {
    position: relative;
    display: inline-flex;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 4px;
    min-width: 28px;
    min-height: 28px;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  /* Override ContextRing's cursor: default when rendered inside the trigger. */
  .trigger :global(.meter) {
    cursor: pointer;
  }
  .trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs, 4px);
  }
  @media (pointer: coarse) {
    .trigger {
      min-width: 44px;
      min-height: 44px;
    }
  }

  /* Transparent positioner: sits flush against the trigger's top edge and pads
     downward to bridge the gap to the card, so the hover region is continuous.
     Mirrors TaskList.svelte's .pop pattern. */
  .pop {
    position: absolute;
    bottom: 100%;
    left: auto;
    right: 0;
    padding-bottom: 7px;
    z-index: 60;
  }
  .pop-card {
    min-width: 220px;
    max-width: min(320px, calc(100vw - 40px));
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-pop);
    padding: 8px 10px;
    animation: pop-rise 0.14s ease;
  }
  @keyframes pop-rise {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pop-card {
      animation: none;
    }
  }
  .pop-head {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 2px 6px;
  }
  .detail {
    font-size: 13px;
    line-height: 1.4;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    padding: 1px 2px;
  }
  .detail.muted {
    color: var(--text-muted);
    font-size: 12px;
  }
  .bar {
    margin: 6px 2px 4px;
    height: 6px;
    border-radius: 3px;
    background: var(--border-strong);
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
  }
  .bar.ok .bar-fill {
    background: var(--ok);
  }
  .bar.warning .bar-fill {
    background: var(--warning);
  }
  .bar.accent .bar-fill {
    background: var(--accent);
  }
  .bar.danger .bar-fill {
    background: var(--danger);
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    padding: 0 2px;
  }
  .action {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 12px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 5px 8px;
    border-radius: var(--radius-xs, 6px);
    cursor: pointer;
    white-space: nowrap;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .action:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .action:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  /* Armed (click-twice confirm): destructive red so the operator sees the
     consequence of a second click. Mirrors Transcript.svelte's .branch.armed. */
  .action.armed {
    color: var(--danger);
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .action.armed:hover {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
  }
</style>
