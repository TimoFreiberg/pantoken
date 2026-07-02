<script lang="ts">
  import type { Snippet } from "svelte";
  import Chevron from "./Chevron.svelte";
  import { reveal } from "../../lib/transitions.js";

  // Shared dropdown primitive for the badge-style pickers in the composer toolbar
  // (FacetBadge, PermissionBadge). Owns the open/close state, keyboard navigation
  // (Esc/↑↓/↵), the click-away backdrop, and the panel/badge/group-title/kbd-hint
  // chrome — the ~120 lines of near-identical panel CSS + onKeydown each picker
  // carried. The caller passes the panel body (option buttons + any extras like
  // FacetBadge's handoff toggle / reload) as a snippet, receiving the current
  // keyboard-highlight index `sel` and a `close()` callback. This replaces the
  // per-picker copies and keeps them from drifting behaviorally.
  //
  // Conventions (AGENTS.md): <Chevron variant="menu"> for the glyph,
  // transition:reveal for the open/close animation. Every clickable element carries
  // a title; the backdrop is the one exception (invisible click-away — aria-label
  // only, matching the prior pickers).
  let {
    label,
    title,
    testid,
    ariaLabel,
    groupTitle,
    count = 0,
    initialSel = 0,
    accent = false,
    badgeClass = "",
    minWidth = "200px",
    closeLabel = "Close menu",
    onSelect,
    body,
  }: {
    label: string;
    title: string;
    testid?: string;
    ariaLabel: string;
    groupTitle: string;
    count?: number;
    initialSel?: number;
    accent?: boolean;
    badgeClass?: string;
    minWidth?: string;
    closeLabel?: string;
    onSelect?: (index: number) => void;
    body: Snippet<[{ sel: number; close: () => void }]>;
  } = $props();

  let open = $state(false);
  let sel = $state(0);

  function toggle() {
    if (open) {
      close();
    } else {
      sel = initialSel;
      open = true;
    }
  }
  function close() {
    open = false;
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(sel + 1, count - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onSelect?.(sel);
      close();
    }
  }
</script>

<div class="anchor">
  <button
    class="badge {badgeClass}"
    class:accent
    data-testid={testid}
    {title}
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={toggle}
  >
    <span class="badge-text">{label}</span>
    <Chevron open={open} variant="menu" size={10} />
  </button>
  {#if open}
    <div
      class="panel"
      role="listbox"
      aria-label={ariaLabel}
      tabindex="-1"
      transition:reveal
      style:min-width={minWidth}
      onkeydown={onKeydown}
    >
      <div class="group-title">{groupTitle}</div>
      {@render body({ sel, close })}
      <div class="kbd-hint">↑↓ move · ↵ select · esc cancel</div>
    </div>
  {/if}
</div>

{#if open}
  <button class="backdrop" aria-label={closeLabel} onclick={close}></button>
{/if}

<style>
  .anchor {
    position: relative;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    letter-spacing: -0.01em;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 3px 9px;
    border-radius: 999px;
    cursor: pointer;
  }
  .badge-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Accent tint — the "not the default/active" signal (plan facet, non-standard
     permission mode). The marker class (plan/nonstandard) is also on the badge for
     test assertions; the visual styling lives here once. */
  .badge.accent {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .badge:hover {
    border-color: var(--border-strong);
  }
  .badge:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .panel {
    position: absolute;
    /* Opens UPWARD: the picker lives in the composer footer at the bottom of the
       viewport, so a downward panel would fall off-screen. */
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 50;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 4px;
  }
  .group-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    padding: 4px 8px 2px;
  }
  .kbd-hint {
    padding: 6px 8px 3px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
    text-align: center;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 40;
    cursor: default;
  }
</style>
