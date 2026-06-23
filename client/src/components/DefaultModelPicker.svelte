<script lang="ts">
  import { tick } from "svelte";
  import type { ModelOption } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import { reveal } from "../lib/transitions.js";
  import Chevron from "./ui/Chevron.svelte";

  // The Settings "Default model" control. A native <select> can't host a search box, and
  // the full list grows long with every connected provider — so this is a small custom
  // picker: filtered to favorites (when any are set), with a filter-as-you-type box. The
  // menu expands inline (a sibling row, not a floating overlay) because the settings body
  // is overflow:auto and would clip an absolutely-positioned dropdown.

  let open = $state(false);

  const defaults = $derived(store.modelDefaults);
  const activeOpt = $derived(
    store.models.find(
      (m) => m.provider === defaults.provider && m.modelId === defaults.modelId,
    ),
  );
  // Friendly label in the trigger (raw id before the model list arrives / if the stored
  // default isn't among the available models); the raw provider:id stays in the tooltip.
  const triggerLabel = $derived(activeOpt?.label ?? defaults.modelId ?? "Choose…");
  const triggerTitle = $derived(
    defaults.modelId
      ? defaults.provider
        ? `Default model: ${defaults.provider}:${defaults.modelId}`
        : `Default model: ${defaults.modelId}`
      : "Choose a default model for new sessions",
  );

  // Favorites filter: when favorites are set, offer only those — but always keep the
  // current default visible/selectable even if it's not favorited (mirrors the header
  // picker's treatment of the active model). Empty favorites = offer every model.
  const filtering = $derived(store.modelDefaults.favorites.length > 0);
  const choices = $derived.by(() => {
    const favs = store.modelDefaults.favorites;
    if (favs.length === 0) return store.models;
    const set = new Set(favs);
    return store.models.filter(
      (m) =>
        set.has(`${m.provider}:${m.modelId}`) ||
        (m.provider === defaults.provider && m.modelId === defaults.modelId),
    );
  });

  // Filter-as-you-type within the menu (label / id / provider).
  let query = $state("");
  const q = $derived(query.trim().toLowerCase());
  const groups = $derived.by(() => {
    const m = new Map<string, ModelOption[]>();
    for (const opt of choices) {
      if (
        q &&
        !opt.label.toLowerCase().includes(q) &&
        !opt.modelId.toLowerCase().includes(q) &&
        !opt.provider.toLowerCase().includes(q)
      )
        continue;
      const arr = m.get(opt.provider);
      if (arr) arr.push(opt);
      else m.set(opt.provider, [opt]);
    }
    return [...m.entries()].map(([provider, items]) => ({ provider, items }));
  });
  // Flat list of visible rows in render order — arrow-key nav walks this; `sel` indexes it.
  const flatItems = $derived(groups.flatMap((g) => g.items));

  let sel = $state(0);
  let searchEl = $state<HTMLInputElement>();
  let menuEl = $state<HTMLDivElement>();

  // Reset the query + highlight whenever the menu closes, so it's fresh on next open.
  $effect(() => {
    if (!open) {
      query = "";
      sel = 0;
    }
  });
  // Keep the highlight in range as the filter shrinks the list under the cursor.
  $effect(() => {
    if (open && sel >= flatItems.length) sel = 0;
  });
  // Scroll the keyboard-highlighted row into view as the user arrows past the fold.
  $effect(() => {
    if (!open) return;
    sel;
    tick().then(() =>
      menuEl?.querySelector(".dm-item.hl")?.scrollIntoView({ block: "nearest" }),
    );
  });

  function toggle(): void {
    open = !open;
    if (open) tick().then(() => searchEl?.focus());
  }
  function pick(provider: string, modelId: string): void {
    if (!(provider === defaults.provider && modelId === defaults.modelId))
      store.setDefaultModel(provider, modelId);
    open = false;
  }
  function onKeydown(e: KeyboardEvent): void {
    const n = flatItems.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      if (n) sel = (sel + 1) % n;
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      if (n) sel = (sel - 1 + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = flatItems[sel];
      if (it) pick(it.provider, it.modelId);
    } else if (e.key === "Escape") {
      // Clear a non-empty query first; an empty box closes the menu. Stop propagation so
      // the settings panel's own Escape handler doesn't fire underneath.
      e.preventDefault();
      e.stopPropagation();
      if (q) query = "";
      else open = false;
    }
  }
</script>

<div class="dm">
  <button
    class="dm-trigger"
    type="button"
    aria-haspopup="listbox"
    aria-expanded={open}
    data-testid="default-model"
    title={triggerTitle}
    onclick={toggle}
  >
    <span class="dm-trigger-label">{triggerLabel}</span>
    <Chevron {open} variant="menu" size={10} />
  </button>
</div>

{#if open}
  <div class="dm-menu" data-testid="default-model-menu" bind:this={menuEl} transition:reveal>
    <input
      class="dm-search"
      type="text"
      placeholder="Search models…"
      title="Filter models by name, id, or provider (↑↓ move · ↵ select · esc cancel)"
      aria-label="Search models"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      bind:this={searchEl}
      bind:value={query}
      oninput={() => (sel = 0)}
      onkeydown={onKeydown}
    />
    {#if filtering}
      <p class="dm-hint">Showing your favorites — manage them below.</p>
    {/if}
    {#each groups as g (g.provider)}
      <div class="dm-group">{g.provider}</div>
      {#each g.items as opt (opt.modelId)}
        {@const active =
          opt.provider === defaults.provider && opt.modelId === defaults.modelId}
        <button
          class="dm-item"
          class:active
          class:hl={flatItems[sel] === opt}
          type="button"
          data-testid="default-model-option-{opt.provider}-{opt.modelId}"
          title={active ? `${opt.label} (current default)` : `Set ${opt.label} as the default model`}
          onclick={() => pick(opt.provider, opt.modelId)}
        >
          <span class="dm-item-label">{opt.label}</span>
          {#if active}
            <span class="dm-item-meta"
              >default{#if filtering && !store.isFavorite(opt.provider, opt.modelId)}<span
                  class="off"
                  title="Not in favorites — kept visible because it's the current default"
                  > · not favorited</span
                >{/if}</span
            >
          {/if}
        </button>
      {/each}
    {/each}
    {#if groups.length === 0}
      <div class="dm-empty">No models match</div>
    {:else}
      <div class="dm-kbd">↑↓ move · ↵ select · esc cancel</div>
    {/if}
  </div>
{/if}

<style>
  .dm {
    flex: 0 0 auto;
    max-width: 60%;
    margin-left: auto;
  }
  /* The trigger reads like the native <select> it replaces: bordered pill, label + caret. */
  .dm-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 6px 9px;
    cursor: pointer;
  }
  .dm-trigger:hover {
    border-color: var(--border-strong);
    background: var(--surface-sunken);
  }
  .dm-trigger:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .dm-trigger-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Inline-expanding menu — a full-width sibling below the row, not a floating overlay
     (the settings body is overflow:auto and would clip an absolute dropdown). flex-basis
     100% makes it wrap onto its own line under the trigger in the wrapping .dm-row. */
  .dm-menu {
    flex-basis: 100%;
    width: 100%;
    margin: 2px 0;
    max-height: 320px;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px;
  }
  .dm-search {
    width: 100%;
    box-sizing: border-box;
    font-size: 12.5px;
    color: var(--text);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    margin-bottom: 4px;
  }
  .dm-search:focus {
    outline: none;
    border-color: var(--accent);
  }
  .dm-hint {
    margin: 2px 4px 4px;
    font-size: 11px;
    color: var(--text-faint);
  }
  .dm-group {
    padding: 6px 8px 3px;
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .dm-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 8px;
    cursor: pointer;
    color: var(--text);
  }
  .dm-item:hover {
    background: var(--surface-sunken);
  }
  .dm-item.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  /* Keyboard highlight — a ring, so it reads on the active row's accent fill too. */
  .dm-item.hl {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .dm-item-label {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dm-item-meta {
    font-size: 11px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .off {
    color: var(--text-faint);
  }
  .dm-empty {
    padding: 8px;
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
  }
  .dm-kbd {
    padding: 6px 8px 3px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
    text-align: center;
  }
</style>
