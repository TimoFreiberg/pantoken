<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import MenuBadge from "./ui/MenuBadge.svelte";

  // Facet picker in the composer toolbar. Shows the ACTUAL current facet — the
  // draft's pick while drafting a new session, else the active session's live
  // facet (composerFacet unifies the two, mirroring composerConfig); clicking
  // opens a dropdown listing all available facets (from `polytoken vfs ls
  // polytoken://facets`). The active facet gets an accent tint. ⌘⇧C cycles
  // through all facets (works even when the composer is focused) — the dropdown
  // is for discovering and switching to specific facets.
  //
  // The dropdown chrome (badge, open/close, keyboard nav, backdrop, panel CSS)
  // lives in MenuBadge; this component supplies the facet items + the handoff
  // toggle + reload button as the panel body snippet.
  const facet = $derived(store.composerFacet);
  const isPlan = $derived(facet?.toLowerCase() === "plan");
  const label = $derived(isPlan ? "Plan" : facet.charAt(0).toUpperCase() + facet.slice(1));
  const facets = $derived(store.facets);
  // Adventurous handoff lives in this menu because it's a plan-mode modifier
  // in spirit: it lets plan mode hand off to implementation autonomously. It's
  // a live per-session daemon flag, so it hides while drafting (no session yet).
  const handoff = $derived(store.session.adventurousHandoff ?? false);
</script>

<MenuBadge
  {label}
  title={`Facet: ${facet} — click to switch (⌘⇧C cycles facets)`}
  testid="facet-badge"
  ariaLabel="Facet"
  groupTitle="Facet"
  count={facets.length}
  initialSel={Math.max(0, facets.indexOf(facet))}
  accent={isPlan}
  badgeClass={isPlan ? "facet-badge plan" : "facet-badge"}
  minWidth="160px"
  closeLabel="Close facet menu"
  onSelect={(i) => store.setFacet(facets[i] ?? "execute")}
>
  {#snippet body({ sel, close })}
    {#each facets as opt, i (opt)}
      <button
        class="item"
        class:active={opt === facet}
        class:hl={sel === i}
        role="option"
        aria-selected={sel === i}
        title={opt === facet ? `Facet: ${opt} (current)` : `Switch to ${opt} facet`}
        onclick={() => {
          store.setFacet(opt);
          close();
        }}
      >
        <span class="item-label">{opt.charAt(0).toUpperCase() + opt.slice(1)}</span>
      </button>
    {/each}
    {#if !store.draft}
      <button
        class="handoff"
        role="switch"
        aria-checked={handoff}
        data-testid="adventurous-handoff"
        title={handoff
          ? "Disable adventurous handoff — plan mode waits for your approval"
          : "Enable adventurous handoff — plan mode may start implementing autonomously"}
        onclick={() => store.toggleAdventurousHandoff()}
      >
        <span class="item-label">Adventurous handoff</span>
        <span class="pill" class:on={handoff}>{handoff ? "On" : "Off"}</span>
      </button>
    {/if}
    <button
      class="reload"
      title="Reload the facet list from disk"
      onclick={() => {
        store.refreshFacets();
        close();
      }}
    >
      ↻ Reload facets
    </button>
  {/snippet}
</MenuBadge>

<style>
  .item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    cursor: pointer;
    color: var(--text);
  }
  .item-label {
    font-size: 12.5px;
  }
  .item.hl {
    background: var(--surface-sunken);
  }
  .item.active .item-label {
    font-weight: 600;
  }
  .handoff {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-top: 1px solid var(--border);
    padding: 7px 8px;
    margin-top: 2px;
    cursor: pointer;
    color: var(--text);
  }
  .handoff:hover {
    background: var(--surface-sunken);
  }
  .handoff .pill {
    font-size: 11px;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .handoff .pill.on {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .reload {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-top: 1px solid var(--border);
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    padding: 6px 8px;
    margin-top: 2px;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 11px;
  }
  .reload:hover {
    color: var(--text);
  }
</style>
