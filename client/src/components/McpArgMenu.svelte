<script lang="ts">
  import type { McpServerInfo } from "@pantoken/protocol";
  import type { McpActionItem } from "../lib/slash.js";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  // Presentational only: the Composer owns the open/filter/selection state machine
  // and all key handling. We render the list and report intent (pick / hover) back
  // up. Mirrors SlashMenu's shape — the only difference is the row content: a
  // server stage shows a status dot + name + tool count; an action stage shows the
  // action name + a one-line description.
  let {
    stage,
    items,
    selected,
    onpick,
    onhover,
  }: {
    stage: "server" | "action";
    items: McpServerInfo[] | McpActionItem[];
    selected: number;
    onpick: (item: McpServerInfo | McpActionItem) => void;
    onhover: (index: number) => void;
  } = $props();
</script>

<div
  id="mcp-arg-menu"
  class="mcp-arg-menu"
  role="listbox"
  aria-label={stage === "server" ? "MCP servers" : "MCP actions"}
  data-testid="mcp-arg-menu"
  data-stage={stage}
  use:scrollIndexIntoView={selected}
>
  {#if stage === "server"}
    {#each items as srv, i ((srv as McpServerInfo).serverName)}
      <button
        type="button"
        class="row"
        class:sel={i === selected}
        data-i={i}
        data-server={(srv as McpServerInfo).serverName}
        role="option"
        aria-selected={i === selected}
        title={`Select ${(srv as McpServerInfo).serverName} (↑↓ to move, ↵/Tab to select, Esc to dismiss)`}
        onmousedown={(e) => {
          e.preventDefault();
          onpick(srv as McpServerInfo);
        }}
        onmouseenter={() => onhover(i)}
      >
        <span
          class="mcp-dot mcp-{(srv as McpServerInfo).status}"
          aria-hidden="true"
        ></span>
        <span class="name">{(srv as McpServerInfo).serverName}</span>
        {#if (srv as McpServerInfo).toolCount > 0}
          <span class="tools"
            >{(srv as McpServerInfo).toolCount} tool{(srv as McpServerInfo).toolCount === 1 ? "" : "s"}</span
          >
        {/if}
        <span class="status">{(srv as McpServerInfo).status}</span>
      </button>
    {/each}
  {:else}
    {#each items as act, i ((act as McpActionItem).action)}
      <button
        type="button"
        class="row"
        class:sel={i === selected}
        data-i={i}
        data-action={(act as McpActionItem).action}
        role="option"
        aria-selected={i === selected}
        title={`Run ${(act as McpActionItem).action} (↑↓ to move, ↵/Tab to select, Esc to dismiss)`}
        onmousedown={(e) => {
          e.preventDefault();
          onpick(act as McpActionItem);
        }}
        onmouseenter={() => onhover(i)}
      >
        <span class="name">{(act as McpActionItem).action}</span>
        <span class="desc">{(act as McpActionItem).description}</span>
      </button>
    {/each}
  {/if}
  <div class="footer">↑↓ navigate · ↵ select · esc dismiss</div>
</div>

<style>
  .mcp-arg-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    z-index: 50;
    max-height: min(46vh, 320px);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 4px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 9px;
    cursor: pointer;
    color: var(--text);
  }
  /* Selection is keyboard-driven; hover mirrors it via onhover, so we only style .sel. */
  .row.sel {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .name {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
  }
  .desc {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mcp-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
  }
  .mcp-dot.mcp-connected {
    background: var(--ok);
  }
  .mcp-dot.mcp-disconnected {
    background: var(--text-faint);
  }
  .mcp-dot.mcp-reconnecting {
    background: var(--warning);
  }
  .mcp-dot.mcp-disabled {
    background: var(--danger);
  }
  .tools {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-faint);
  }
  .status {
    flex-shrink: 0;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .footer {
    padding: 6px 9px 3px;
    font-size: 11px;
    color: var(--text-faint);
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }
</style>
