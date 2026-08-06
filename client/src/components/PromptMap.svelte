<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { overlayHistory, PHONE_MQ } from "../lib/overlay-history.js";
  import {
    PROMPT_MAP_RAIL_INSET,
    PROMPT_MAP_TICK_PITCH,
    calculatePromptIntervals,
    pairPromptTicks,
    projectPromptCluster,
    responseFallback,
    responsePreview,
    selectPromptWindow,
    truncatePromptPreview,
    type PromptMapEntry,
  } from "../lib/prompt-map.js";

  interface Props {
    entries: PromptMapEntry[];
    scroller: HTMLDivElement | undefined;
    sessionKey?: string;
    onjump: (target: HTMLElement) => void;
  }

  let { entries, scroller, sessionKey = "", onjump }: Props = $props();

  const MAP_ID = "prompt-map";
  let phone = $state(false);
  let rail = $state<HTMLElement>();
  let sheet = $state<HTMLElement>();
  let sheetOpen = $state(false);
  let historyTracked = false;
  let handledClose = false;
  let activeIndices = $state<number[]>([]);
  let primaryIndex = $state(0);
  let tickPairs = $state<Array<{ index: number; position: number }>>([]);
  let omittedBefore = $state(false);
  let omittedAfter = $state(false);
  let overCapacity = $state(false);
  let hoveredIndex = $state<number | null>(null);
  let focusedIndex = $state<number | null>(null);
  let cachedOffsets = new Map<string, number>();
  let frame = 0;
  let resizeObserver: ResizeObserver | undefined;
  let mediaQuery: MediaQueryList | undefined;
  let coarseQuery: MediaQueryList | undefined;
  let observedScroller: HTMLDivElement | undefined;
  let removeScrollerListener: (() => void) | undefined;
  let attachScroller: (() => void) | undefined;
  let observedTurns = new Set<HTMLElement>();

  const isPhoneLayout = $derived(phone);
  const showMap = $derived(entries.length >= 2);
  const previewIndex = $derived(focusedIndex ?? hoveredIndex);

  function updatePhone(): void {
    const next = Boolean(mediaQuery?.matches || coarseQuery?.matches);
    // A layout transition is a local close, not the browser-back callback. Remove the
    // tracked history entry before switching away from the phone presentation.
    if (phone && !next && historyTracked) closeSheet();
    phone = next;
    scheduleMeasure();
  }

  function scheduleMeasure(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  }

  function measure(): void {
    if (!scroller || entries.length < 2) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const currentTurns = new Set<HTMLElement>();
    for (const entry of entries) {
      const turn = scroller.querySelector<HTMLElement>(
        `.transcript-turn[data-prompt-id="${CSS.escape(entry.id)}"]`,
      );
      if (turn) currentTurns.add(turn);
    }
    const changedTurns = currentTurns.size !== observedTurns.size ||
      [...currentTurns].some((turn) => !observedTurns.has(turn));
    if (changedTurns && resizeObserver) {
      for (const turn of observedTurns) {
        if (!currentTurns.has(turn)) resizeObserver.unobserve(turn);
      }
      for (const turn of currentTurns) resizeObserver.observe(turn);
      observedTurns = currentTurns;
    }
    const offsets: number[] = [];
    for (const entry of entries) {
      const row = scroller.querySelector<HTMLElement>(
        `.transcript-turn[data-prompt-id="${CSS.escape(entry.id)}"]`,
      );
      if (row) {
        const rect = row.getBoundingClientRect();
        if (rect.height > 0 || rect.top !== 0) {
          const offset = Math.max(0, rect.top - scrollerRect.top + scroller.scrollTop);
          cachedOffsets.set(entry.id, offset);
        }
      }
      offsets.push(cachedOffsets.get(entry.id) ?? (offsets.at(-1) ?? 0));
    }
    const intervals = calculatePromptIntervals(
      offsets,
      scroller.scrollTop,
      scroller.clientHeight,
      scroller.scrollHeight,
      entries.map((entry) => entry.id),
    );
    const active = intervals.filter((interval) => interval.active).map((interval) => interval.index);
    const nearest = intervals
      .map((interval) => ({ index: interval.index, distance: interval.start > scroller.scrollTop + scroller.clientHeight ? interval.start - (scroller.scrollTop + scroller.clientHeight) : scroller.scrollTop - interval.end }))
      .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))[0]?.index;
    const railHeight = Math.max(rail?.clientHeight ?? 0, scroller.clientHeight);
    const available = railHeight * 0.6;
    const selected = selectPromptWindow({
      total: entries.length,
      activeIndices: active,
      availableHeight: available,
      tickPitch: PROMPT_MAP_TICK_PITCH,
      contextPadding: 1,
      nearestIndex: nearest,
      stablePrimaryIndex: primaryIndex,
    });
    const selectedOffsets = selected.indices.map((index) => {
      const interval = intervals[index];
      return interval ? (interval.start + interval.end) / 2 : offsets[index] ?? 0;
    });
    // Compact, vertically centered cluster: project the selected offsets into a
    // bounded span (minimum pitch per marker, capped at the usable rail height for
    // over-capacity selections) and pair each projected position with its original
    // prompt index, so sparse selections never render extra ticks.
    const positions = projectPromptCluster(
      selectedOffsets,
      Math.max(0, railHeight),
      PROMPT_MAP_TICK_PITCH,
      PROMPT_MAP_RAIL_INSET,
    );
    activeIndices = active;
    primaryIndex = selected.primaryIndex ?? primaryIndex;
    tickPairs = pairPromptTicks(selected.indices, positions);
    omittedBefore = selected.omittedBefore;
    omittedAfter = selected.omittedAfter;
    overCapacity = selected.overCapacity;
  }

  function jump(index: number): void {
    if (index < 0 || index >= entries.length || !scroller) return;
    const entry = entries[index];
    if (!entry) return;
    const target =
      scroller.querySelector<HTMLElement>(
        `.row.user[data-prompt-id="${CSS.escape(entry.id)}"]`,
      ) ??
      scroller.querySelector<HTMLElement>(
        `.transcript-turn[data-prompt-id="${CSS.escape(entry.id)}"]`,
      );
    if (!target) return;
    onjump(target);
    sheetOpen = false;
    if (historyTracked) {
      handledClose = true;
      overlayHistory.closed(MAP_ID);
      historyTracked = false;
    }
  }

  function openSheet(): void {
    if (!isPhoneLayout || !showMap || sheetOpen) return;
    handledClose = false;
    sheetOpen = true;
    historyTracked = true;
    overlayHistory.opened(MAP_ID, () => {
      handledClose = true;
      historyTracked = false;
      sheetOpen = false;
    });
    void tick().then(() => {
      sheet?.querySelector<HTMLElement>(".sheet-row.primary")?.scrollIntoView({ block: "nearest" });
    });
  }

  function closeSheet(fromHistory = false): void {
    if (!sheetOpen && !historyTracked) return;
    sheetOpen = false;
    if (historyTracked && !handledClose && !fromHistory) {
      handledClose = true;
      overlayHistory.closed(MAP_ID);
    }
    historyTracked = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && sheetOpen) {
      event.preventDefault();
      closeSheet();
    }
  }

  function entryLabel(index: number): string {
    const entry = entries[index]!;
    const prompt = truncatePromptPreview(entry.prompt) || "Untitled prompt";
    return `Prompt ${index + 1} of ${entries.length}: ${prompt}`;
  }

  $effect(() => {
    void sessionKey;
    void entries;
    void scroller;
    cachedOffsets = new Map();
    attachScroller?.();
    scheduleMeasure();
  });

  onMount(() => {
    mediaQuery = window.matchMedia(PHONE_MQ);
    coarseQuery = window.matchMedia("(pointer: coarse)");
    updatePhone();
    mediaQuery.addEventListener("change", updatePhone);
    coarseQuery.addEventListener("change", updatePhone);
    window.addEventListener("keydown", onKeydown);
    const onScroll = () => scheduleMeasure();
    attachScroller = () => {
      if (!scroller || scroller === observedScroller) return;
      removeScrollerListener?.();
      const nextScroller = scroller;
      observedScroller = nextScroller;
      nextScroller.addEventListener("scroll", onScroll, { passive: true });
      removeScrollerListener = () => nextScroller.removeEventListener("scroll", onScroll);
      resizeObserver?.observe(nextScroller);
      scheduleMeasure();
    };
    resizeObserver = new ResizeObserver(scheduleMeasure);
    attachScroller();
    if (rail) resizeObserver.observe(rail);
    scheduleMeasure();
    return () => {
      mediaQuery?.removeEventListener("change", updatePhone);
      coarseQuery?.removeEventListener("change", updatePhone);
      window.removeEventListener("keydown", onKeydown);
      removeScrollerListener?.();
    };
  });

  onDestroy(() => {
    if (frame) cancelAnimationFrame(frame);
    observedTurns.clear();
    resizeObserver?.disconnect();
    if (historyTracked && !handledClose) overlayHistory.closed(MAP_ID);
  });
</script>

{#if showMap}
  <aside
    class="prompt-map"
    class:phone={isPhoneLayout}
    aria-label="Prompt map"
    data-testid="prompt-map"
    data-over-capacity={overCapacity ? "true" : undefined}
  >
    <div class="desktop-rail" bind:this={rail}>
      {#if omittedBefore}<span class="fade top" aria-hidden="true"></span>{/if}
      {#each tickPairs as tick (tick.index)}
        {@const index = tick.index}
        {@const entry = entries[index]}
        {#if entry}
          {@const active = activeIndices.includes(index)}
          <button
            type="button"
            class="tick"
            class:active
            class:primary={primaryIndex === index}
            class:emphasized={hoveredIndex === index || focusedIndex === index}
            style={`top: ${tick.position}px`}
            title={entryLabel(index)}
            aria-label={entryLabel(index)}
            data-testid="prompt-map-tick"
            data-prompt-index={index}
            onclick={() => jump(index)}
            onmouseenter={() => (hoveredIndex = index)}
            onmouseleave={() => (hoveredIndex = null)}
            onfocus={() => (focusedIndex = index)}
            onblur={() => (focusedIndex = null)}
          >
            <span class="tick-mark"></span>
          </button>
        {/if}
      {/each}
      {#if omittedAfter}<span class="fade bottom" aria-hidden="true"></span>{/if}
      {#if previewIndex !== null}
        {@const entry = entries[previewIndex]}
        {#if entry}
          <div class="preview" role="status" data-testid="prompt-map-preview">
            <strong>{truncatePromptPreview(entry.prompt) || "Untitled prompt"}</strong>
            {#each responsePreview(entry.response) as line}
              <span>{line}</span>
            {:else}
              <span class="fallback">{responseFallback(entry.responseState)}</span>
            {/each}
          </div>
        {/if}
      {/if}
    </div>

    <button
      class="outline-trigger"
      type="button"
      aria-label={`Open prompt outline, current prompt ${primaryIndex + 1} of ${entries.length}`}
      data-testid="prompt-map-trigger"
      onclick={openSheet}
    >
      <span aria-hidden="true">☷</span>
      <span>Outline</span>
    </button>
  </aside>
{/if}

{#if sheetOpen}
  <div class="sheet-scrim" role="presentation" onclick={() => closeSheet()}></div>
  <section class="sheet" bind:this={sheet} role="dialog" aria-modal="true" aria-labelledby="prompt-map-heading" data-testid="prompt-map-sheet">
    <header class="sheet-head">
      <h2 id="prompt-map-heading">Prompt outline</h2>
      <button type="button" class="sheet-close" aria-label="Close prompt outline" onclick={() => closeSheet()}>×</button>
    </header>
    <div class="sheet-list">
      {#each entries as entry, index (entry.id)}
        <button
          class="sheet-row"
          class:primary={primaryIndex === index}
          type="button"
          aria-label={entryLabel(index)}
          data-testid="prompt-map-row"
          onclick={() => jump(index)}
        >
          <span class="row-number">{index + 1}</span>
          <span class="row-copy">
            <strong>{truncatePromptPreview(entry.prompt) || "Untitled prompt"}</strong>
            {#each responsePreview(entry.response) as line}
              <span>{line}</span>
            {:else}
              <span class="fallback">{responseFallback(entry.responseState)}</span>
            {/each}
          </span>
        </button>
      {/each}
    </div>
  </section>
{/if}

<style>
  .prompt-map { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
  .desktop-rail { position: absolute; left: 5px; top: 0; bottom: 0; width: 28px; pointer-events: auto; }
  .tick { position: absolute; left: 6px; width: 20px; height: 18px; transform: translateY(-50%); padding: 0; border: 0; background: transparent; cursor: pointer; }
  .tick-mark { display: block; width: 9px; height: 3px; margin: 7px auto; border-radius: 3px; background: var(--text-faint); opacity: .65; transition: width .12s, background .12s, opacity .12s; }
  .tick:hover .tick-mark, .tick:focus-visible .tick-mark { width: 15px; background: var(--accent); opacity: 1; }
  .tick.active .tick-mark { width: 13px; background: var(--text-muted); opacity: .95; }
  .tick.primary .tick-mark { width: 17px; background: var(--accent); }
  /* Hover/focus emphasis must survive the active/primary rules above (same specificity,
     later order): the explicit class wins for the hovered/focused marker in every state. */
  .tick.emphasized .tick-mark { width: 15px; background: var(--accent); opacity: 1; }
  .tick:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
  .fade { position: absolute; left: 4px; width: 18px; height: 28px; pointer-events: none; background: linear-gradient(var(--surface), transparent); opacity: .86; }
  .fade.top { top: 0; } .fade.bottom { bottom: 0; transform: rotate(180deg); }
  .preview { position: absolute; left: 27px; top: 50%; width: min(270px, calc(100vw - 60px)); max-height: 116px; overflow: hidden; display: flex; flex-direction: column; gap: 4px; padding: 9px 11px; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); box-shadow: var(--shadow-card); font-size: 12px; line-height: 1.35; }
  .preview strong, .preview span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview .fallback, .fallback { color: var(--text-muted); font-style: italic; }
  .outline-trigger, .sheet, .sheet-scrim { display: none; }
  @media (pointer: coarse), (max-width: 859px) {
    .desktop-rail { display: none; }
    .outline-trigger { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 8px; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--text-muted); background: color-mix(in srgb, var(--surface) 92%, transparent); box-shadow: var(--shadow-pop); pointer-events: auto; font-size: 12px; }
    .outline-trigger span:first-child { font-size: 20px; line-height: 1; }
    .prompt-map.phone { pointer-events: none; }
    .sheet-scrim { position: fixed; inset: 0; z-index: 100; display: block; background: rgb(0 0 0 / .28); pointer-events: auto; }
    .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 101; display: flex; flex-direction: column; max-height: min(78vh, 680px); padding: 12px 14px max(14px, env(safe-area-inset-bottom)); background: var(--surface); border: 1px solid var(--border); border-bottom: 0; border-radius: 16px 16px 0 0; box-shadow: var(--shadow-card); pointer-events: auto; }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 2px 10px; }
    .sheet-head h2 { margin: 0; font-size: 16px; }
    .sheet-close { min-width: 44px; min-height: 44px; border: 0; background: transparent; color: var(--text-muted); font-size: 26px; cursor: pointer; }
    .sheet-list { overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
    .sheet-row { display: flex; gap: 10px; width: 100%; min-height: 52px; padding: 9px 8px; text-align: left; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer; }
    .sheet-row:hover, .sheet-row:focus-visible, .sheet-row.primary { background: var(--surface-sunken); border-color: var(--accent); }
    .sheet-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .row-number { flex: 0 0 22px; color: var(--text-faint); font-size: 12px; padding-top: 2px; text-align: center; }
    .row-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; line-height: 1.35; }
    .row-copy strong, .row-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
  @media (prefers-reduced-motion: reduce) { .tick-mark { transition: none; } }
</style>
