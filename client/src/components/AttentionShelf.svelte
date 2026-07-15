<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { attention } from "../lib/attention-cycle.svelte.js";
  import { reveal } from "../lib/transitions.js";
  import Chevron from "./ui/Chevron.svelte";

  const pending = $derived(store.session.pendingApprovals);
  const first = $derived(pending[0] ?? null);
  const count = $derived(pending.length);

  function kindLabel(): string {
    return first?.kind === "qna" ? "Question pending" : "Approval required";
  }
  function requestTitle(): string {
    if (!first) return "Waiting on you";
    if (first.kind === "qna")
      return first.title ?? first.questions[0]?.question ?? "Question from the agent";
    return "title" in first && typeof first.title === "string"
      ? first.title
      : `Agent request: ${first.kind}`;
  }
</script>

{#if store.phoneLayout && attention.mobileMinimized && first}
  <div class="shelf-wrap" transition:reveal={{ duration: 140 }}>
    <button
      type="button"
      class="shelf"
      onclick={() => attention.restoreMobile(first.requestId)}
      aria-label={`Open ${kindLabel().toLowerCase()}: ${requestTitle()}`}
      title={`Open ${kindLabel().toLowerCase()}: ${requestTitle()}`}
    >
      <span class="copy">
        <span class="kind">{count > 1 ? `${count} items need attention` : kindLabel()}</span>
        <span class="request-title">{requestTitle()}</span>
      </span>
      <Chevron open={false} size={13} />
    </button>
  </div>
{/if}

<style>
  .shelf-wrap { display: none; }
  @media (max-width: 859px) {
    .shelf-wrap { display: block; flex: 0 0 auto; padding: 0 10px 6px; }
    .shelf {
      width: 100%; min-height: 52px; display: flex; align-items: center; gap: 12px;
      padding: 7px 12px; color: var(--text); background: var(--highlight-soft);
      border: 1px solid color-mix(in srgb, var(--highlight) 44%, var(--border));
      border-radius: var(--radius-sm); font-family: var(--font-sans); text-align: left;
    }
    .copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
    .kind { font-size: 12px; font-weight: 600; color: var(--text); }
    .request-title {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text-muted); font-size: 13px;
    }
  }
</style>
