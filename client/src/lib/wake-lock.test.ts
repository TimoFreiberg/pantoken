import { describe, expect, test } from "bun:test";
import { createWakeLock } from "./wake-lock.js";

function fakeSentinel() {
  let releaseCb: (() => void) | null = null;
  return {
    released: 0,
    release: async function () {
      this.released++;
      releaseCb?.();
    },
    addEventListener(_t: "release", cb: () => void) {
      releaseCb = cb;
    },
  };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe("createWakeLock", () => {
  test("acquires while wanted and releases when not", async () => {
    const s = fakeSentinel();
    const wl = createWakeLock(async () => s);

    wl.set(true);
    await flush();
    expect(wl.held).toBe(true);

    wl.set(false);
    await flush();
    expect(wl.held).toBe(false);
    expect(s.released).toBe(1);
  });

  test("toggling off mid-request never leaves a stale lock held", async () => {
    const s = fakeSentinel();
    const wl = createWakeLock(async () => s);
    wl.set(true); // request in flight…
    wl.set(false); // …toggled off before it resolves
    await flush();
    expect(wl.held).toBe(false);
    expect(s.released).toBe(1); // the resolved sentinel was released, not retained
  });

  test("reacquire re-requests only while still wanted", async () => {
    let requests = 0;
    const wl = createWakeLock(async () => {
      requests++;
      return fakeSentinel();
    });

    wl.set(true);
    await flush();
    expect(requests).toBe(1);

    // Simulate the OS dropping the lock (sentinel auto-released), then a visibility regain.
    wl.set(false);
    await flush();
    wl.reacquire(); // not wanted anymore → no new request
    await flush();
    expect(requests).toBe(1);
  });

  test("no request fn (unsupported) is a silent no-op", async () => {
    const wl = createWakeLock(null);
    wl.set(true);
    await flush();
    expect(wl.held).toBe(false);
  });
});
