// App-icon badge upkeep. The service worker SETS the badge from push payloads
// (see public/sw.js); this side CLEARS it whenever the app comes to the
// foreground — once you're looking at the app, the "N sessions need you" badge
// has done its job (the in-app UI shows the live state). Cleared on every
// visible-transition rather than tracking counts client-side: the next push
// re-sets it from server truth.
//
// Dependency-injected for tests; the default env binds to the real
// document/navigator and no-ops when the Badging API is missing (desktop
// browsers without it, plain http, jsdom).

export interface AppBadgeEnv {
  /** navigator.clearAppBadge, if the platform has one. */
  clearAppBadge: (() => Promise<void>) | undefined;
  isVisible(): boolean;
  /** Subscribe to "the app became visible/focused"; returns unsubscribe. */
  onVisible(handler: () => void): () => void;
}

/** Start clearing the badge on foreground transitions (and once immediately if
 *  already visible). Returns a stop function. */
export function watchAppBadgeClear(
  env: AppBadgeEnv = browserEnv(),
): () => void {
  const clear = () => {
    if (!env.isVisible()) return;
    void env.clearAppBadge?.()?.catch(() => {
      /* best-effort — a failed clear just leaves a stale badge */
    });
  };
  clear();
  return env.onVisible(clear);
}

function browserEnv(): AppBadgeEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const clearAppBadge = nav?.clearAppBadge?.bind(nav);
  return {
    clearAppBadge,
    isVisible: () =>
      typeof document !== "undefined" && document.visibilityState === "visible",
    onVisible: (handler) => {
      if (typeof window === "undefined") return () => {};
      document.addEventListener("visibilitychange", handler);
      window.addEventListener("focus", handler);
      return () => {
        document.removeEventListener("visibilitychange", handler);
        window.removeEventListener("focus", handler);
      };
    },
  };
}
