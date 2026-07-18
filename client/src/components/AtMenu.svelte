<script lang="ts">
  import type { AtItem } from "../lib/file-autocomplete.js";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  // Presentational only: the Composer owns the open/filter/selection state machine and
  // all key handling. We render the list and report intent (pick / hover) back up.
  // Generalized from the old file-only FileMenu: a row can now be a file, a skill,
  // a subagent, a model, or a "sigil" row that narrows the query into one of those
  // kinds (the `@skill:` etc. keep-narrowing mechanic, same idea as a directory `/`).
  let {
    items,
    selected,
    reasoningLevel = null,
    ignoreOff = null,
    onpick,
    onhover,
  }: {
    items: readonly AtItem[];
    selected: number;
    /** The reasoning level dialed in (via `[`/`]`) for the currently selected model
     *  row, or null when none is chosen. Rendered only on that row — see the `model`
     *  branch below. Irrelevant for every other row kind. */
    reasoningLevel?: string | null;
    /** The Shift+Tab ignore-rules toggle state, or `null` when the current mode has no
     *  notion of "ignored" (skill/subagent/model takeovers) — the footer hint is omitted
     *  entirely in that case. `false` = hidden dotfiles/gitignored entries stay hidden
     *  (default); `true` = revealed. */
    ignoreOff?: boolean | null;
    onpick: (item: AtItem) => void;
    onhover: (index: number) => void;
  } = $props();

  const KEYBOARD_HINT = "(↑↓ to move, ↵/Tab to select, Esc to dismiss)";
  const hasModelRow = $derived(items.some((item) => item.kind === "model"));
  // Built as one expression (rather than inline template text + a `{#if}`) so Svelte's
  // whitespace trimming around block boundaries can't silently eat the separating space.
  const footerHint = $derived(
    "↑↓ navigate · ↵ select · esc dismiss · skill: subagent: model: for more" +
      (hasModelRow ? " · [ ] reasoning" : "") +
      (ignoreOff === null
        ? ""
        : ignoreOff
          ? " · ignored files shown · ⇧Tab hide"
          : " · ⇧Tab ignored files"),
  );

  function rowKey(item: AtItem): string {
    switch (item.kind) {
      case "file":
        return `file:${item.file.path}`;
      case "skill":
        return `skill:${item.name}`;
      case "subagent":
        return `subagent:${item.name}`;
      case "model":
        return `model:${item.model.provider}/${item.model.modelId}`;
      case "sigil":
        return `sigil:${item.prefix}`;
    }
  }

  function rowTitle(item: AtItem): string {
    switch (item.kind) {
      case "file":
        return `Insert @${item.file.path}${item.file.isDirectory ? "/" : ""} ${KEYBOARD_HINT}`;
      case "skill":
        return `Insert @skill:${item.name} ${KEYBOARD_HINT}`;
      case "subagent":
        return `Insert @subagent:${item.name} ${KEYBOARD_HINT}`;
      case "model":
        return `Insert @model:${item.model.provider}/${item.model.modelId} — [ ] adjust reasoning ${KEYBOARD_HINT}`;
      case "sigil":
        return `Insert @${item.prefix} to ${item.label} ${KEYBOARD_HINT}`;
    }
  }
</script>

<!-- The menu is a flex column: the .list region scrolls while the .footer stays pinned
     at the bottom (issue #53 — the footer used to scroll away with the rows). The
     always-open behavior (Composer renders this whenever the cursor is inside an @-token,
     even with zero matches) means the footer/hotkeys are always reachable; a zero-item
     list shows a "No matches" body instead of hiding the whole menu. -->
<div
  class="menu"
  id="at-menu"
  role="listbox"
  aria-label="References"
  data-testid="at-menu"
>
  <!-- use:scrollIndexIntoView keeps the keyboard-selected row in view as you arrow past
       the fold. It queries `[data-i]` within this node, so it must sit on the scroll
       container that owns the rows. -->
  <div class="list" use:scrollIndexIntoView={selected}>
    {#if items.length === 0}
      <!-- Non-interactive: not a selectable option, just a presentational empty state.
           aria-live so screen readers announce the transition into/out of "No matches"
           (the textarea's aria-expanded/aria-controls point here regardless of count). -->
      <div class="empty" aria-live="polite">No matches</div>
    {:else}
      {#each items as item, i (rowKey(item))}
        <button
          type="button"
          class="row"
          class:sel={i === selected}
          data-i={i}
          data-kind={item.kind}
          data-ref={rowKey(item)}
          role="option"
          aria-selected={i === selected}
          title={rowTitle(item)}
          onmousedown={(e) => {
            e.preventDefault();
            onpick(item);
          }}
          onmouseenter={() => onhover(i)}
        >
          {#if item.kind === "file"}
            <span class="icon" aria-hidden="true">{item.file.isDirectory ? "▸" : "▹"}</span>
            <span class="name"
              >{item.file.path}{#if item.file.isDirectory}<span class="sep">/</span>{/if}</span
            >
          {:else if item.kind === "skill"}
            <!-- Front `kind:` prefix mirrors the search term's structure (polytoken TUI
                 parity) — the row reads as `skill:name`, the same shape the user would
                 type. Replaces the old dim right-edge kind badge. -->
            <span class="prefix">skill:</span><span class="name">{item.name}</span>
          {:else if item.kind === "subagent"}
            <span class="prefix">subagent:</span><span class="name">{item.name}</span>
          {:else if item.kind === "model"}
            <span class="prefix">model:</span><span class="name">{item.model.provider}/{item.model.modelId}</span>
            {#if item.model.label && item.model.label !== item.model.modelId}
              <span class="meta">{item.model.label}</span>
            {/if}
            {#if i === selected && reasoningLevel !== null}
              <span class="reasoning">reasoning: {reasoningLevel}</span>
            {/if}
          {:else if item.kind === "sigil"}
            <span class="icon" aria-hidden="true">▸</span>
            <span class="name sigil">{item.prefix}</span>
            <span class="meta">{item.label}</span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
  <div class="footer">{footerHint}</div>
</div>

<style>
  .menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    z-index: 50;
    max-height: min(46vh, 320px);
    /* Flex column so the list region scrolls while the footer stays pinned at the
       bottom (issue #53). The menu's own max-height caps the whole stack. */
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 4px;
  }
  .list {
    /* The scrollable region: takes the available height (up to the menu's max-height
       minus the footer), scrolls when rows overflow. min-height:0 lets flex shrink it
       below its content so the footer can stay visible. */
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 9px;
    cursor: pointer;
    color: var(--text);
  }
  .row.sel {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .icon {
    flex-shrink: 0;
    width: 14px;
    font-size: 11px;
    color: var(--text-faint);
    text-align: center;
  }
  /* Front `kind:` prefix on skill/subagent/model rows — mirrors the search term's
     structure (polytoken TUI parity). Mono font, muted so the name reads as the
     primary text. flex-shrink:0 so it never collapses. */
  .prefix {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-muted);
  }
  .name {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }
  /* Files are the common case and can be long paths — let them use the full row,
     unlike the other kinds whose name is a short slug next to a prefix/description. */
  .row[data-kind="file"] .name {
    flex-shrink: 1;
    max-width: none;
  }
  .sigil {
    color: var(--text-muted);
  }
  .sep {
    color: var(--text-faint);
  }
  /* Secondary muted text: a model's friendly label, or a sigil row's description. */
  .meta {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The selected model row's dialed-in reasoning level (`[`/`]`) — right-aligned,
      mirroring the polytoken TUI. `margin-left: auto` pushes it to the row's right
      edge when `.meta` is absent; when `.meta` is present its own flex-grow already
      claims the free space, so this row still reads right-aligned as a group. */
  .reasoning {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    padding-left: 8px;
  }
  /* Empty state: shown when the @-query matches zero candidates. Non-interactive
     (not a button/option) — the menu stays open so the footer/hotkeys remain
     reachable (issue #53). */
  .empty {
    padding: 7px 9px;
    font-size: 13px;
    color: var(--text-faint);
    font-style: italic;
  }
  .footer {
    /* Pinned sibling of .list — stays at the bottom while the list scrolls. */
    flex-shrink: 0;
    padding: 6px 9px 3px;
    font-size: 11px;
    color: var(--text-faint);
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }
</style>
