// Desktop shell bridge: call the Tauri `request_dock_attention` command to
// bounce the macOS dock icon. No-op outside the Tauri webview — the IPC
// internals are only injected when a capability grants the remote URL access
// (see desktop/capabilities/dock-attention.json). We call __TAURI_INTERNALS__
// directly rather than importing @tauri-apps/api, keeping the client's
// zero-Tauri-dependency design (AGENTS.md: "the hub-served web client gets NO
// Tauri IPC" — this is the same narrow exception as data-tauri-drag-region).

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

/** True when running inside the Pantoken Tauri desktop shell. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

/**
 * Bounce the macOS dock icon. Called when the agent's turn ends or needs input
 * and the window is unfocused. Silently no-ops in a browser/PWA context.
 */
export function requestDockAttention(): void {
  if (!isDesktopShell()) return;
  // Fire-and-forget — the command returns immediately; the bounce is
  // cancelled automatically when the user activates the app.
  window.__TAURI_INTERNALS__!.invoke("request_dock_attention").catch(() => {
    // If the command isn't registered or the capability isn't granted, fail
    // silently — this is a best-effort UX nicety, not a critical path.
  });
}
