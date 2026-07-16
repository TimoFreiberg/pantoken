<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { overlayHistory } from "../lib/overlay-history.js";
  import { store } from "../lib/store.svelte.js";
  import Chevron from "./ui/Chevron.svelte";

  let {
    selected,
    onpick,
    onclose,
  }: {
    selected: string | undefined;
    onpick: (branch: string | undefined) => void;
    onclose: () => void;
  } = $props();

  let listRef = $state<HTMLDivElement>();
  let highlightIndex = $state(0);
  let handledClose = false;

  const branches = $derived(store.branchList?.branches ?? []);
  const loading = $derived(store.branchLoading);
  const error = $derived(store.branchList?.error === true);
  const truncated = $derived(branches.length === 100);
  // +1 for the "default (auto)" option at the top.
  const optionCount = $derived(branches.length + 1);

  $effect(() => {
    branches;
    highlightIndex = 0;
  });

  $effect(() => {
    if (optionCount === 0) highlightIndex = 0;
    else if (highlightIndex >= optionCount) highlightIndex = optionCount - 1;
  });

  onMount(() => {
    overlayHistory.opened("branch-picker", () => {
      handledClose = true;
      onclose();
    });
  });

  onDestroy(() => {
    if (!handledClose) overlayHistory.closed("branch-picker");
  });

  function closeFromUi(): void {
    handledClose = true;
    overlayHistory.closed("branch-picker");
    onclose();
  }

  function pick(branch: string | undefined): void {
    handledClose = true;
    overlayHistory.closed("branch-picker");
    onpick(branch);
  }

  function onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        highlightIndex = Math.min(highlightIndex + 1, optionCount - 1);
        scrollHighlight();
        break;
      case "ArrowUp":
        e.preventDefault();
        highlightIndex = Math.max(highlightIndex - 1, 0);
        scrollHighlight();
        break;
      case "Enter":
        e.preventDefault();
        if (highlightIndex === 0) pick(undefined);
        else pick(branches[highlightIndex - 1]);
        break;
      case "Escape":
        e.preventDefault();
        closeFromUi();
        break;
    }
  }

  function scrollHighlight(): void {
    listRef
      ?.querySelector<HTMLElement>(`[data-i="${highlightIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="branch-picker-overlay"
  role="listbox"
  aria-label="Select base branch"
  tabindex="-1"
  bind:this={listRef}
>
  {#if loading}
    <div class="branch-status">Loading branches…</div>
  {:else if error}
    <div class="branch-status branch-error">
      Couldn't list branches — not a repo or the command failed.
    </div>
  {:else if branches.length === 0}
    <div class="branch-status">No branches found.</div>
  {:else}
    <button
      type="button"
      class="branch-option"
      class:selected={!selected}
      data-i={0}
      role="option"
      aria-selected={!selected}
      onclick={() => pick(undefined)}
    >
      <span class="branch-name">default (auto)</span>
      {#if !selected}<Chevron open={false} variant="menu" size={10} />{/if}
    </button>
    {#each branches as branch, i}
      <button
        type="button"
        class="branch-option"
        class:selected={branch === selected}
        class:highlighted={highlightIndex === i + 1}
        data-i={i + 1}
        role="option"
        aria-selected={branch === selected}
        onclick={() => pick(branch)}
      >
        <span class="branch-name">{branch}</span>
        {#if branch === selected}<Chevron open={false} variant="menu" size={10} />{/if}
      </button>
    {/each}
    {#if truncated}
      <div class="branch-truncated">List capped at 100 branches.</div>
    {/if}
  {/if}
</div>

<style>
  .branch-picker-overlay {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg-elevated, #fff);
    border: 1px solid var(--border-subtle, #e0e0e0);
    border-radius: 8px;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.08);
    z-index: 10;
    margin-bottom: 4px;
    padding: 4px;
  }

  .branch-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: none;
    color: var(--text-primary, inherit);
    cursor: pointer;
    border-radius: 6px;
    font-size: inherit;
    text-align: left;
  }

  .branch-option:hover,
  .branch-option.highlighted {
    background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  }

  .branch-option.selected {
    font-weight: 600;
  }

  .branch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .branch-status {
    padding: 10px 12px;
    color: var(--text-secondary, #888);
    font-size: 0.85em;
  }

  .branch-error {
    color: var(--text-danger, #c00);
  }

  .branch-truncated {
    padding: 4px 10px;
    color: var(--text-secondary, #888);
    font-size: 0.75em;
    font-style: italic;
  }

  @media (prefers-color-scheme: dark) {
    .branch-picker-overlay {
      background: var(--bg-elevated, #1e1e1e);
      border-color: var(--border-subtle, #333);
      box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.3);
    }
    .branch-option:hover,
    .branch-option.highlighted {
      background: var(--bg-hover, rgba(255, 255, 255, 0.08));
    }
  }
</style>
