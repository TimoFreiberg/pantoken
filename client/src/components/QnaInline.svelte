<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { attention } from "../lib/attention-cycle.svelte.js";
  import QnaForm, { type QnaDraft } from "./QnaForm.svelte";

  // The Q&A form renders inline in the chat column (above the composer), not as a
  // floating sheet like the other dialogs — matching the chat-native placement the
  // Claude app uses. ApprovalLayer deliberately skips `qna` so this owns it; the two
  // can show at once on desktop (a floating confirm over the inline form) without fighting.
  const pending = $derived(store.session.pendingApprovals);
  const mobileCurrent = $derived(
    pending.find((r) => r.requestId === attention.mobileRequestId) ?? pending[0] ?? null,
  );
  const current = $derived(
    store.phoneLayout
      ? mobileCurrent?.kind === "qna" ? mobileCurrent : null
      : pending.find((r) => r.kind === "qna") ?? null,
  );
  const mobileIndex = $derived(
    current ? pending.findIndex((r) => r.requestId === current.requestId) : -1,
  );

  // Q&A answers are local drafts until Submit. Keyed by session/request so focusing
  // another chat can unmount the form without discarding typed answers.
  const qnaDrafts = new Map<string, QnaDraft>();
  function qnaKey(requestId: string): string {
    return `${store.session.ref?.sessionId ?? "unknown"}:${requestId}`;
  }
  function rememberQna(key: string, draft: QnaDraft): void {
    qnaDrafts.set(key, draft);
    if (qnaDrafts.size > 20) {
      const oldest = qnaDrafts.keys().next().value;
      if (oldest) qnaDrafts.delete(oldest);
    }
  }

  // Two collapse levels:
  // 1. QnaForm's own `collapsed` — collapses the body to just the title bar
  //    (the form's internal minimize button). Owned here, passed as a prop.
  // 2. The attention cycle's `minimized.qna` — collapses the ENTIRE form to a
  //    small pill (the ⌘\ cycle). Owned by the controller.
  // When the controller minimizes to a pill, QnaForm isn't rendered at all; when
  // QnaForm collapses to its title bar, the form is still visible (just shorter).
  const pillMinimized = $derived(
    store.phoneLayout ? attention.mobileMinimized : attention.minimized.qna,
  );
  let bodyCollapsed = $state(false);

  // Per-request reset: desktop clears its per-surface pill; both layouts expand the
  // question body. Phone's shared minimized shelf intentionally remains sticky.
  let lastRequestId: string | undefined;
  $effect(() => {
    const id = current?.requestId;
    if (id !== lastRequestId) {
      if (lastRequestId !== undefined) attention.clear("qna");
      lastRequestId = id;
      bodyCollapsed = false;
    }
  });

  // Re-focus when cycled back to via ⌘\.
  $effect(() => {
    if (attention.focused === "qna" && !attention.minimized.qna) {
      queueMicrotask(() => {
        const el = document.querySelector<HTMLElement>(".qna-inline .qna");
        el?.focus();
      });
    }
  });

  function cancel(requestId: string): void {
    qnaDrafts.delete(qnaKey(requestId));
    attention.clear("qna");
    store.respondUi({ requestId, cancelled: true });
  }

  function moveMobile(delta: number): void {
    if (pending.length < 2 || mobileIndex < 0) return;
    const next = pending[(mobileIndex + delta + pending.length) % pending.length];
    if (next) attention.selectMobile(next.requestId);
  }
</script>

{#if current}
  {@const draftKey = qnaKey(current.requestId)}
  {#if pillMinimized}
    <div class="qna-inline-wrap">
      <div class="qna-inline">
        <button
          type="button"
          class="attention-pill"
          onclick={() => attention.restore("qna")}
          title="Question pending — click or press ⌘\ to restore"
        >
          <span class="pill-label">1 question pending</span>
        </button>
      </div>
    </div>
  {:else}
    <div class="qna-inline-wrap" class:phone-full={store.phoneLayout}>
      <div class="qna-inline">
        {#if store.phoneLayout && pending.length > 1}
          <nav class="request-nav" aria-label="Pending requests">
            <button type="button" onclick={() => moveMobile(-1)} title="Previous pending request" aria-label="Previous pending request">Previous</button>
            <span>{mobileIndex + 1} of {pending.length}</span>
            <button type="button" onclick={() => moveMobile(1)} title="Next pending request" aria-label="Next pending request">Next</button>
          </nav>
        {/if}
        {#key current.requestId}
          <QnaForm
            request={current}
            collapsed={bodyCollapsed}
            fullScreen={store.phoneLayout}
            onMinimize={() => store.phoneLayout ? attention.minimizeMobile() : (bodyCollapsed = !bodyCollapsed)}
            initialDraft={qnaDrafts.get(draftKey)}
            onchange={(draft) => rememberQna(draftKey, draft)}
            onsubmit={(answers) => {
              qnaDrafts.delete(draftKey);
              attention.clear("qna");
              store.respondUi({ requestId: current.requestId, answers });
            }}
            oncancel={() => cancel(current.requestId)}
          />
        {/key}
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Full-width gutter so the card aligns to the same column as the composer. */
  .qna-inline-wrap {
    padding: 0 16px 10px;
  }
  .qna-inline {
    max-width: var(--maxw);
    margin: 0 auto;
    box-sizing: border-box;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
    font-size: calc(15px * var(--font-scale, 1));
  }
  .request-nav { display: none; }
  @media (max-width: 859px) {
    .qna-inline-wrap.phone-full {
      position: absolute; inset: 0; z-index: 45; padding: 0;
      background: var(--bg-elevated);
    }
    .phone-full .qna-inline {
      max-width: none; height: 100%; margin: 0; padding: max(8px, env(safe-area-inset-top)) 16px max(12px, env(safe-area-inset-bottom));
      border: 0; border-radius: 0; box-shadow: none; display: flex; flex-direction: column;
    }
    .request-nav {
      display: flex; min-height: 44px; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--border); margin-bottom: 8px;
      color: var(--text-faint); font-size: 12px;
    }
    .request-nav button {
      min-width: 72px; min-height: 44px; border: 0; background: transparent;
      color: var(--text-muted); font: inherit;
    }
    .phone-full :global(.qna) { min-height: 0; flex: 1; }
  }
  /* Minimized pill — reuses TaskList's .pill visual language. */
  .attention-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    background: var(--highlight-soft);
    border: 1px solid color-mix(in srgb, var(--highlight) 42%, var(--border));
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    max-width: 100%;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  @media (max-width: 859px) { .attention-pill { display: none; } }
  .attention-pill:hover {
    color: var(--text);
    border-color: var(--highlight);
  }
  .attention-pill:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .pill-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
