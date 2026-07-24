<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { reveal } from "../lib/transitions.js";
  import { overlayHistory } from "../lib/overlay-history.js";
  import { store } from "../lib/store.svelte.js";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";
  import { deriveKnownProjects, rankProjects } from "../lib/project-menu.js";

  let {
    current,
    onpick,
    onbrowse,
    onclose,
  }: {
    current: string;
    onpick: (cwd: string) => void;
    onbrowse: () => void;
    onclose: () => void;
  } = $props();

  let inputRef = $state<HTMLInputElement>();
  let panelRef = $state<HTMLElement>();
  let query = $state("");
  let selected = $state(0);
  let handledClose = false;

  const allProjects = $derived(deriveKnownProjects(store.sessions));
  const filtered = $derived(rankProjects(allProjects, query));
  // The "New project…" entry is always present as the last option.
  const optionCount = $derived(filtered.length + 1);
  const newProjectIndex = $derived(filtered.length);

  $effect(() => {
    query;
    selected = 0;
  });

  // Clamp selection into range when the list changes.
  $effect(() => {
    if (optionCount === 0) selected = 0;
    else if (selected >= optionCount) selected = optionCount - 1;
  });

  function move(delta: number): void {
    if (optionCount) selected = (selected + delta + optionCount) % optionCount;
  }

  /** Enter or click on the highlighted option. Closes the menu's overlay
   *  history entry, then calls onpick or onbrowse — each owns its own focus
   *  restoration so the DirPicker handoff (onbrowse) isn't raced. */
  function activateSelected(): void {
    if (selected === newProjectIndex) {
      handledClose = true;
      overlayHistory.closed("project-menu");
      onbrowse();
      return;
    }
    const project = filtered[selected];
    if (project) {
      handledClose = true;
      overlayHistory.closed("project-menu");
      onpick(project.cwd);
    }
  }

  /** Close the overlay history entry + unmount via onclose (escape / backdrop /
   *  window-Esc). Pick and browse paths call onpick/onbrowse instead — they
   *  own their own focus restoration so the DirPicker handoff isn't raced. */
  function closeFromUi(): void {
    handledClose = true;
    overlayHistory.closed("project-menu");
    onclose();
  }

  onMount(() => {
    requestAnimationFrame(() => {
      inputRef?.focus();
    });
    overlayHistory.opened("project-menu", () => {
      handledClose = true;
      onclose();
    });
  });

  onDestroy(() => {
    if (!handledClose) overlayHistory.closed("project-menu");
  });

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFromUi();
      return;
    }
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateSelected();
      return;
    }
  }

  // Escape closes the menu from anywhere — the panel's own onkeydown only fires
  // when focus is inside it, but focus may still be on the trigger button (the
  // input is focused in a requestAnimationFrame on mount, which can race with a
  // fast Escape). Mirrors DirPicker's onWindowKeydown.
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFromUi();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="scrim"
  data-testid="project-menu-scrim"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) closeFromUi();
  }}
>
  <div
    class="picker"
    role="listbox"
    aria-label="Choose a project"
    data-testid="project-menu"
    tabindex="-1"
    bind:this={panelRef}
    transition:reveal
    use:scrollIndexIntoView={selected}
  >
    <div class="search-row">
      <input
        bind:this={inputRef}
        bind:value={query}
        class="search-input"
        aria-label="Filter projects"
        aria-controls="project-menu-results"
        aria-activedescendant={optionCount ? `project-option-${selected}` : undefined}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="Search projects…"
        onkeydown={onInputKeydown}
      />
    </div>

    <div id="project-menu-results" class="results">
      {#each filtered as project, index (project.cwd)}
        {@const optionIndex = index}
        <button
          id={`project-option-${optionIndex}`}
          class="result project"
          class:selected={selected === optionIndex}
          class:active={project.cwd === current}
          data-i={optionIndex}
          role="option"
          aria-selected={selected === optionIndex}
          aria-current={project.cwd === current ? "true" : undefined}
          title={project.cwd}
          onmouseenter={() => (selected = optionIndex)}
          onclick={() => {
            selected = optionIndex;
            activateSelected();
          }}
        >
          <svg class="folder" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.75 6.25A2.25 2.25 0 0 1 5 4h3l1.5 1.75H15A2.25 2.25 0 0 1 17.25 8v6A2.25 2.25 0 0 1 15 16.25H5A2.25 2.25 0 0 1 2.75 14z"/></svg>
          <span class="name">{project.name}</span>
        </button>
      {/each}

      {#if filtered.length === 0}
        <div class="message">No matching projects.</div>
      {/if}

      <div class="separator"></div>
      <button
        id={`project-option-${newProjectIndex}`}
        class="result new-project"
        class:selected={selected === newProjectIndex}
        data-i={newProjectIndex}
        role="option"
        aria-selected={selected === newProjectIndex}
        title="Browse the server filesystem for a new project directory"
        onmouseenter={() => (selected = newProjectIndex)}
        onclick={() => {
          selected = newProjectIndex;
          activateSelected();
        }}
      >
        <span class="plus" aria-hidden="true">+</span>
        <span>New project…</span>
      </button>
    </div>

    <footer aria-hidden="true">
      <span><kbd>↑↓</kbd> navigate</span>
      <span><kbd>Enter</kbd> select</span>
      <span><kbd>Esc</kbd> close</span>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 110;
    display: grid;
    place-items: center;
    padding: 24px;
    background: color-mix(in srgb, var(--backdrop, #111) 52%, transparent);
  }
  .picker {
    width: min(480px, calc(100vw - 48px));
    max-height: min(480px, calc(100dvh - 48px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg, 14px);
    box-shadow: var(--shadow-card);
  }
  .search-row {
    padding: 11px 12px;
    border-bottom: 1px solid var(--border);
  }
  .search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    color: var(--text);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    outline: none;
    font: 13.5px/1.4 var(--font-sans);
  }
  .search-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .results {
    min-height: 64px;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 5px;
  }
  .result {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 40px;
    padding: 7px 10px;
    text-align: left;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13.5px;
  }
  .result.selected {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .result.active {
    font-weight: 600;
  }
  .result.active .name::before {
    content: "";
  }
  .folder {
    flex: 0 0 18px;
    width: 18px;
    height: 18px;
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.5;
  }
  .plus {
    flex: 0 0 18px;
    width: 18px;
    text-align: center;
    font-size: 17px;
    color: var(--text-muted);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .separator {
    height: 1px;
    margin: 4px 8px;
    background: var(--border);
  }
  .new-project {
    color: var(--text-muted);
  }
  .message {
    padding: 18px 12px;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  footer {
    display: flex;
    gap: 16px;
    padding: 8px 12px;
    color: var(--text-faint);
    border-top: 1px solid var(--border);
    font-size: 11px;
  }
  kbd {
    font: inherit;
    color: var(--text-muted);
  }
  .result:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  @media (max-width: 859px) {
    .scrim {
      display: block;
      padding: 0;
      background: var(--surface);
    }
    .picker {
      width: 100vw;
      height: 100dvh;
      max-height: none;
      max-width: none;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .search-row {
      padding: calc(env(safe-area-inset-top) + 10px) 8px 10px;
    }
    .search-input {
      min-height: 44px;
      font-size: 16px;
    }
    .results {
      padding: 4px;
    }
    .result {
      min-height: 48px;
      padding-inline: 12px;
    }
    footer {
      display: none;
    }
  }
</style>
