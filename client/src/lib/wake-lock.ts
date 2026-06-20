// Keep the screen awake while a turn streams, so a phone you're watching doesn't sleep
// mid-run. The Screen Wake Lock API auto-releases when the tab is hidden, so we re-acquire
// on visibility regain. A progressive enhancement: a no-op where unsupported or denied.

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: "release", cb: () => void): void;
}
type RequestFn = () => Promise<Sentinel>;

/** Manage a single wake-lock against a desired on/off state. Pure of the DOM — the
 *  browser wiring is injected — so the acquire/release logic is unit-testable. */
export function createWakeLock(request: RequestFn | null) {
  let sentinel: Sentinel | null = null;
  let want = false;
  let acquiring = false;

  async function acquire(): Promise<void> {
    if (!want || sentinel || acquiring || !request) return;
    acquiring = true;
    try {
      const s = await request();
      if (!want) {
        // Toggled off while the request was in flight — don't hold a stale lock.
        await s.release().catch(() => {});
        return;
      }
      sentinel = s;
      s.addEventListener("release", () => {
        sentinel = null;
      });
    } catch {
      // Unsupported / denied / not visible — harmless; a later reacquire() can retry.
    } finally {
      acquiring = false;
    }
  }

  async function release(): Promise<void> {
    const s = sentinel;
    sentinel = null;
    if (s) await s.release().catch(() => {});
  }

  return {
    /** Request the lock while `on`, release it otherwise. */
    set(on: boolean): void {
      want = on;
      if (on) void acquire();
      else void release();
    },
    /** Re-request after the OS dropped the lock (e.g. tab regained focus). */
    reacquire(): void {
      if (want) void acquire();
    },
    get held(): boolean {
      return sentinel !== null;
    },
  };
}

const browserRequest: RequestFn | null =
  typeof navigator !== "undefined" && "wakeLock" in navigator
    ? () =>
        (
          navigator as Navigator & {
            wakeLock: { request(type: "screen"): Promise<Sentinel> };
          }
        ).wakeLock.request("screen")
    : null;

export const wakeLock = createWakeLock(browserRequest);

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wakeLock.reacquire();
  });
}
