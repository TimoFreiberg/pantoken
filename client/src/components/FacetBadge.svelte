<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  // Facet indicator relocated to the composer toolbar (the "bottom bar" where
  // model/effort live). Shows the ACTUAL current facet ("Execute" / "Plan") as a
  // state readout, not the old affordance label ("Plan" meant "click to enter plan").
  // Clicking toggles execute ↔ plan; the label always reflects the live facet, so
  // the control reads as state, not a static hint.
  const facet = $derived(store.session.facet ?? "execute");
  const label = $derived(facet === "plan" ? "Plan" : "Execute");
  const isPlan = $derived(facet === "plan");
  const target = $derived(isPlan ? "execute" : "plan");
</script>

<!-- Canonical title template (single source of truth; e2e asserts this exact string):
     `Facet: ${facet} — click to switch to ${target} (Shift+Tab)` -->
<button
  class="badge facet-badge"
  class:plan={isPlan}
  data-testid="facet-badge"
  title={`Facet: ${facet} — click to switch to ${target} (Shift+Tab)`}
  onclick={() => store.setFacet(target)}
>
  <span class="badge-text">{label}</span>
</button>

<style>
  /* Mirrors ModelPicker's `.badge` visual language (rounded pill, surface-sunken
     bg) so it reads as a sibling chip next to the model/effort badges. Two states:
     execute (default, subtle) and plan (accent-tinted — preserves the "plan mode is
     special" signal the old accent pill carried). */
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
  /* Plan mode: accent-tinted — the active non-default facet reads as "on". */
  .badge.plan {
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
</style>
