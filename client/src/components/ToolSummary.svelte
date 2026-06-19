<script lang="ts">
  import type { MergedToolsItem } from "../lib/transcript-view.js";
  import { mergedSummary } from "../lib/transcript-view.js";
  import ToolCard from "./ToolCard.svelte";

  let {
    item,
    open,
    ontoggle,
  }: {
    item: MergedToolsItem;
    open: boolean;
    ontoggle: () => void;
  } = $props();

  const status = $derived.by(() => {
    if (item.tools.some((tool) => tool.status === "error")) return "error";
    if (item.tools.some((tool) => tool.status === "running")) return "running";
    return "ok";
  });
  const statusIcon: Record<string, string> = {
    running: "○",
    ok: "●",
    error: "✕",
  };
</script>

<div class="tool summary {status}">
  <button
    class="head"
    title={`${open ? "Collapse" : "Expand"} ${mergedSummary(item)} (Enter)`}
    onclick={ontoggle}
    aria-expanded={open}
  >
    <span class="status">{statusIcon[status]}</span>
    <span class="name">{item.tools.length} {item.tools.length === 1 ? "tool" : "tools"}</span>
    <span class="arg">{item.names.join(", ")}</span>
    <span class="chev" class:open>▸</span>
  </button>
  {#if open}
    <div class="body">
      {#each item.tools as tool (tool.id)}
        <ToolCard item={tool} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Deliberately matches ToolCard's shell exactly: a summary should feel like the
     same component at a higher level, not a second visual language. */
  .tool {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    overflow: hidden;
    content-visibility: auto;
    contain-intrinsic-size: auto 42px;
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    background: none;
    border: none;
    padding: 9px 12px;
    text-align: left;
    color: var(--text);
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .head:hover {
    background: var(--surface-sunken);
  }
  .head:focus-visible {
    outline: none;
    background: var(--surface-sunken);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .status {
    font-size: 9px;
    line-height: 1;
  }
  .tool.running .status {
    color: var(--accent);
    animation: blink 1s ease-in-out infinite;
  }
  .tool.ok .status {
    color: var(--ok);
  }
  .tool.error .status {
    color: var(--danger);
  }
  @keyframes blink {
    50% {
      opacity: 0.3;
    }
  }
  .name {
    font-weight: 550;
    font-size: 13.5px;
    flex-shrink: 0;
  }
  .arg {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .chev {
    font-size: 10px;
    color: var(--text-faint);
    flex-shrink: 0;
    transition: transform 0.15s ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .body {
    border-top: 1px solid var(--border);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: reveal 0.16s ease;
  }
  @keyframes reveal {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
