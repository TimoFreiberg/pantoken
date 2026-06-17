<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  const conn = $derived(store.connection);
  const s = $derived(store.session);
  const model = $derived(s.config.modelId ?? "—");
  const provider = $derived(s.config.provider ?? "");
  const statuses = $derived(Object.entries(s.ambient.statuses));

  const push = $derived(store.pushState);
  const pushLabel: Record<string, string> = {
    working: "…",
    idle: "Notify",
    subscribed: "Notify on",
    denied: "Blocked",
    "needs-install": "Install",
    error: "Retry",
    unsupported: "",
  };
  const pushTitle: Record<string, string> = {
    working: "Subscribing…",
    idle: "Enable push notifications on this device",
    subscribed: "Push on — tap to re-check / re-subscribe",
    denied: "Notifications are blocked — enable them in your browser/iOS settings",
    "needs-install":
      "On iOS, Add to Home Screen first, then open the app from there and tap again",
    error: "Couldn't subscribe — tap to retry (see console for details)",
    unsupported: "",
  };

  const connLabel: Record<string, string> = {
    connected: "live",
    connecting: "connecting…",
    reconnecting: "reconnecting…",
    disconnected: "offline",
  };
</script>

<header class="hdr">
  <div class="left">
    <div class="title">{s.ambient.title || s.title || "pilot"}</div>
    <div class="sub">
      <span class="path">{s.ref?.workspaceId ? "pilot" : "no session"}</span>
      {#each statuses as [key, text] (key)}
        <span class="dot-sep">·</span>
        <span class="amb">{text}</span>
      {/each}
    </div>
  </div>

  <div class="right">
    {#if push !== "unsupported"}
      <button
        class="bell {push}"
        title={pushTitle[push]}
        disabled={push === "working"}
        onclick={() => store.enablePush()}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span class="bell-label">{pushLabel[push]}</span>
      </button>
    {/if}
    {#if store.streaming}
      <span class="working"><span class="pulse"></span>working</span>
    {/if}
    <span class="model" title={provider}>{model}</span>
    <span class="conn {conn}" title={conn}>
      <span class="led"></span>{connLabel[conn]}
    </span>
  </div>
</header>

<style>
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .left {
    min-width: 0;
  }
  .title {
    font-weight: 600;
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot-sep {
    color: var(--text-faint);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .model {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 3px 9px;
    border-radius: 999px;
    font-family: var(--font-mono);
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .led {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .conn.connected .led {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
  }
  .conn.reconnecting .led,
  .conn.connecting .led {
    background: var(--warning);
  }
  .conn.disconnected .led {
    background: var(--danger);
  }
  .bell {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 9px 3px 8px;
    cursor: pointer;
  }
  .bell:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .bell.subscribed {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 40%, var(--border));
  }
  .bell.denied {
    color: var(--danger);
  }
  .bell.needs-install,
  .bell.error {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
  }
  .working {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--accent);
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }
</style>
