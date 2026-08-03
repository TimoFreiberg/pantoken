// Overlay ↔ browser-history integration for phone-sized viewports. An "overlay" is
// a view that covers the transcript (the sessions drawer, the full-screen context
// view). On a phone, opening one pushes a history entry so the OS back gesture /
// browser back closes the overlay instead of leaving the app — in a standalone PWA
// there is no browser chrome, so back-gesture correctness is the difference between
// "app" and "webpage" feel. Desktop (≥860px) is untouched: opens don't engage the
// history at all (the panels are docked there, not overlays).
//
// Model: one history entry per tracked overlay, kept 1:1 with an internal stack.
// - popstate (back gesture) closes the top overlay.
// - A UI-initiated close (scrim tap, ✕, selecting a session) consumes its entry via
//   history.back() so the stack never accumulates stale overlay entries.
// - An out-of-order UI close (an overlay under the top one) only drops the
//   bookkeeping; its history entry stays and the next back is a harmless no-op pop.
//
// The module is dependency-injected for tests (no jsdom needed); the default env
// binds to the real window lazily and no-ops outside a browser.

/** The app's single phone breakpoint. Must match the 859px used in component CSS. */
export const PHONE_MQ = "(max-width: 859px)";

export interface OverlayHistoryEnv {
  /** Whether overlay↔history coupling applies (phone-sized viewport). */
  isPhone(): boolean;
  pushState(marker: unknown): void;
  replaceState(marker: unknown): void;
  back(): void;
  /** Register the popstate listener once; return an unsubscribe. */
  onPop(handler: () => void): () => void;
}

interface Entry {
  id: string;
  close: () => void;
}

export function createOverlayHistory(env: OverlayHistoryEnv) {
  const stack: Entry[] = [];
  let installed = false;
  // Set while we unwind our own history.back() from a UI close: that pop is
  // already accounted for and must not close the (new) top overlay.
  let pendingOwnPops = 0;
  // When a peer replaces a hierarchy (parent + nested child), the extra child
  // entries must be traversed before the surviving parent entry can be rewritten
  // as the peer. The peer lives in `stack[0]` while those traversals serialize.
  let pendingReplacementId: string | null = null;
  // Opens requested while a UI-driven Back is still traversing. Usually this is one
  // peer overlay, but a fast drill-in can enqueue a parent plus its nested child before
  // the parent's entry is active. Preserve that hierarchy instead of replacing and
  // closing the deferred parent.
  let deferredStack: Entry[] = [];

  function ensureInstalled(): void {
    if (installed) return;
    installed = true;
    env.onPop(() => {
      if (pendingOwnPops > 0) {
        pendingOwnPops--;
        if (pendingOwnPops > 0) {
          // Serialize multiple UI closes. Calling history.back() twice before the
          // first traversal completes can be coalesced by browsers, stranding the
          // bookkeeping and any deferred open.
          env.back();
        } else {
          if (pendingReplacementId) {
            if (stack[0]?.id === pendingReplacementId)
              env.replaceState({ pantokenOverlay: pendingReplacementId });
            pendingReplacementId = null;
          }
          if (deferredStack.length === 0) return;
          for (const entry of deferredStack) {
            stack.push(entry);
            env.pushState({ pantokenOverlay: entry.id });
          }
          deferredStack = [];
        }
        return;
      }
      const top = stack.pop();
      top?.close();
    });
  }

  return {
    /** An overlay opened. Phone-only; safe to call unconditionally from store actions. */
    opened(id: string, close: () => void): void {
      if (!env.isPhone()) return;
      ensureInstalled();
      // A UI close consumes history asynchronously in real browsers. Opening during
      // that traversal would push an entry that the delayed Back immediately skips
      // over, so defer activation until the owned pop arrives.
      if (pendingOwnPops > 0) {
        if (pendingReplacementId && stack.length === 1) {
          if (stack[0]?.id === id) {
            stack[0].close = close;
            return;
          }
          for (const entry of deferredStack.reverse()) entry.close();
          deferredStack = [];
          stack[0]?.close();
          stack[0] = { id, close };
          pendingReplacementId = id;
          return;
        }
        const existing = deferredStack.find((entry) => entry.id === id);
        if (existing) {
          existing.close = close;
        } else {
          for (const entry of deferredStack.reverse()) entry.close();
          deferredStack = [{ id, close }];
        }
        return;
      }
      // Re-opening an already-tracked overlay (e.g. rapid toggles) must not
      // duplicate its entry — refresh the close callback instead.
      const existing = stack.find((e) => e.id === id);
      if (existing) {
        existing.close = close;
        return;
      }
      // Phone navigation is mutually exclusive. Switching directly between the
      // sessions and context views reuses one root history entry so one Back always
      // returns to the transcript. If the current view has nested children, close the
      // whole hierarchy and serialize traversal of the extra entries before rewriting
      // the surviving root marker as the peer.
      if (stack.length > 1) {
        for (let i = stack.length - 1; i >= 0; i--) stack[i]?.close();
        const extraEntries = stack.length - 1;
        stack.splice(1);
        stack[0] = { id, close };
        pendingReplacementId = id;
        const wasIdle = pendingOwnPops === 0;
        pendingOwnPops += extraEntries;
        if (wasIdle) env.back();
        return;
      }
      if (stack.length > 0) {
        stack[stack.length - 1]?.close();
        stack[stack.length - 1] = { id, close };
        env.replaceState({ pantokenOverlay: id });
        return;
      }
      stack.push({ id, close });
      env.pushState({ pantokenOverlay: id });
    },
    /** Open a child surface above the current phone overlay. Unlike `opened`, this
     *  deliberately keeps the current overlay in the stack: Back closes the child
     *  and reveals its parent. Use this for an action sheet or an expanded search
     *  inside a full-screen phone view, never for peer navigation views. */
    openedNested(id: string, close: () => void): void {
      if (!env.isPhone()) return;
      ensureInstalled();
      if (pendingOwnPops > 0) {
        const existing = deferredStack.find((entry) => entry.id === id);
        if (existing) existing.close = close;
        else deferredStack.push({ id, close });
        return;
      }
      const existing = stack.find((e) => e.id === id);
      if (existing) {
        existing.close = close;
        return;
      }
      stack.push({ id, close });
      env.pushState({ pantokenOverlay: id });
    },
    /** An overlay closed via its own UI (not the back gesture). Consumes the
     *  matching history entry when it's the top one. No-op for untracked ids, so
     *  desktop close paths can call this unconditionally. */
    closed(id: string): void {
      const deferredIdx = deferredStack.findIndex((entry) => entry.id === id);
      if (deferredIdx !== -1) {
        deferredStack.splice(deferredIdx, 1);
        return;
      }
      const idx = stack.findIndex((e) => e.id === id);
      if (idx === -1) return;
      if (pendingReplacementId === id) pendingReplacementId = null;
      const wasTop = idx === stack.length - 1;
      stack.splice(idx, 1);
      if (wasTop) {
        pendingOwnPops++;
        if (pendingOwnPops === 1) env.back();
      }
      // Out-of-order close: the entry's pop will arrive on a future back and be
      // treated as a real pop; with its bookkeeping gone it closes the then-top
      // overlay — acceptable (one extra back at worst, never an app exit).
    },
    /** Test/introspection hook. */
    depth(): number {
      return stack.length + deferredStack.length;
    },
  };
}

function browserEnv(): OverlayHistoryEnv {
  return {
    isPhone: () =>
      typeof window !== "undefined" && window.matchMedia(PHONE_MQ).matches,
    pushState: (marker) => history.pushState(marker, "", location.href),
    replaceState: (marker) => history.replaceState(marker, "", location.href),
    back: () => history.back(),
    onPop: (handler) => {
      window.addEventListener("popstate", handler);
      return () => window.removeEventListener("popstate", handler);
    },
  };
}

/** App-wide singleton bound to the real browser history. */
export const overlayHistory = createOverlayHistory(browserEnv());
