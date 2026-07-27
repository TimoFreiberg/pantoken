<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { reveal } from "../lib/transitions.js";
  import { overlayHistory } from "../lib/overlay-history.js";
  import { store } from "../lib/store.svelte.js";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";
  import { deriveKnownProjects, rankProjects } from "../lib/project-menu.js";
  import DirPicker from "./DirPicker.svelte";

  let inputRef = $state<HTMLInputElement>();
  let query = $state("");
  let selected = $state(0);
  let pickingCwd = $state(false);
  let handledClose = false;

  const allProjects = $derived(deriveKnownProjects(store.sessions));
  const filtered = $derived(rankProjects(allProjects, query));
  // The "Browse…" entry is always present as the last option.
  const optionCount = $derived(filtered.length + 1);
  const browseIndex = $derived(filtered.length);

  // Pre-select the last-active project (store.lastProjectCwd) on first render,
  // so Enter creates in it (the two-keystroke fast path: ⌘N, Enter).
  let preselected = false;
  $effect(() => {
    if (preselected) return;
    if (filtered.length === 0) return;
    const idx = filtered.findIndex((p) => p.cwd === store.lastProjectCwd);
    selected = idx >= 0 ? idx : 0;
    preselected = true;
  });

  // Reset selection to top when the query changes.
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

  function activateSelected(): void {
    if (selected === browseIndex) {
      handledClose = true;
      overlayHistory.closed("session-chooser");
      pickingCwd = true;
      return;
    }
    const project = filtered[selected];
    if (project) {
      handledClose = true;
      overlayHistory.closed("session-chooser");
      store.createSession(project.cwd);
    }
  }

  function closeFromUi(): void {
    handledClose = true;
    overlayHistory.closed("session-chooser");
    store.closeChooser();
  }

  onMount(() => {
    requestAnimationFrame(() => {
      inputRef?.focus();
    });
    overlayHistory.opened("session-chooser", () => {
      handledClose = true;
      store.closeChooser();
    });
  });

  onDestroy(() => {
    if (!handledClose) overlayHistory.closed("session-chooser");
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

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFromUi();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section
  class="chooser"
  data-testid="session-chooser"
  aria-labelledby="chooser-prompt"
  transition:reveal
>
  <div class="composition">
    <h1 id="chooser-prompt">What would you like to work on?</h1>
    <div class="search-row">
      <input
        bind:this={inputRef}
        bind:value={query}
        class="search-input"
        aria-label="Filter projects"
        aria-controls="chooser-results"
        aria-activedescendant={optionCount ? `chooser-option-${selected}` : undefined}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="Search projects…"
        onkeydown={onInputKeydown}
      />
    </div>

    <div id="chooser-results" class="results" role="listbox" aria-label="Choose a project">
      {#each filtered as project, index (project.cwd)}
        {@const optionIndex = index}
        <button
          id={`chooser-option-${optionIndex}`}
          class="result project"
          class:selected={selected === optionIndex}
          class:active={project.cwd === store.lastProjectCwd}
          data-testid="chooser-project-{project.name}"
          data-i={optionIndex}
          role="option"
          aria-selected={selected === optionIndex}
          aria-current={project.cwd === store.lastProjectCwd ? "true" : undefined}
          title={project.cwd}
          use:scrollIndexIntoView={selected}
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
        id={`chooser-option-${browseIndex}`}
        class="result browse"
        class:selected={selected === browseIndex}
        data-testid="chooser-browse"
        data-i={browseIndex}
        role="option"
        aria-selected={selected === browseIndex}
        title="Browse the server filesystem for a project directory"
        use:scrollIndexIntoView={selected}
        onmouseenter={() => (selected = browseIndex)}
        onclick={() => {
          selected = browseIndex;
          activateSelected();
        }}
      >
        <span class="plus" aria-hidden="true">+</span>
        <span>Browse…</span>
      </button>
    </div>

    <footer aria-hidden="true">
      <span><kbd>↑↓</kbd> navigate</span>
      <span><kbd>Enter</kbd> select</span>
      <span><kbd>Esc</kbd> close</span>
    </footer>
  </div>
</section>

{#if pickingCwd}
  <DirPicker
    current={store.lastProjectCwd}
    defaultCwd={store.defaultNewSessionCwd}
    onpick={(path) => {
      pickingCwd = false;
      store.createSession(path);
    }}
    onclose={() => {
      pickingCwd = false;
    }}
  />
{/if}

<style>
  .chooser {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    overflow-y: auto;
    box-sizing: border-box;
    padding-block: clamp(28px, 10vh, 100px) clamp(28px, 14vh, 140px);
  }

  .composition {
    width: min(480px, calc(100% - 48px));
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  h1 {
    margin: 0;
    color: var(--text-muted);
    font-size: 18px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.012em;
  }

  .search-row {
    padding: 0;
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
    max-height: min(420px, calc(100dvh - 280px));
    overflow-y: auto;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
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
  .browse {
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
    padding: 0;
    color: var(--text-faint);
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
    .chooser {
      position: fixed;
      inset: 0;
      z-index: 10;
      padding-block: 12px clamp(20px, 10vh, 72px);
    }
    .composition {
      width: calc(100% - 32px);
    }
    .search-input {
      min-height: 44px;
      font-size: 16px;
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
