import { describe, expect, test } from "bun:test";
import { type AppBadgeEnv, watchAppBadgeClear } from "./app-badge.js";

function fakeEnv(opts: { visible: boolean; hasApi?: boolean }) {
  let clears = 0;
  let visible = opts.visible;
  const handlers: (() => void)[] = [];
  const env: AppBadgeEnv = {
    clearAppBadge:
      opts.hasApi === false
        ? undefined
        : () => {
            clears++;
            return Promise.resolve();
          },
    isVisible: () => visible,
    onVisible: (h) => {
      handlers.push(h);
      return () => handlers.splice(handlers.indexOf(h), 1);
    },
  };
  return {
    env,
    clears: () => clears,
    setVisible: (v: boolean) => {
      visible = v;
      if (v) for (const h of [...handlers]) h();
    },
    handlerCount: () => handlers.length,
  };
}

describe("watchAppBadgeClear", () => {
  test("clears immediately when already visible", () => {
    const f = fakeEnv({ visible: true });
    watchAppBadgeClear(f.env);
    expect(f.clears()).toBe(1);
  });

  test("does not clear while hidden; clears on the visible transition", () => {
    const f = fakeEnv({ visible: false });
    watchAppBadgeClear(f.env);
    expect(f.clears()).toBe(0);
    f.setVisible(true);
    expect(f.clears()).toBe(1);
  });

  test("no Badging API → never throws, never clears", () => {
    const f = fakeEnv({ visible: true, hasApi: false });
    expect(() => watchAppBadgeClear(f.env)).not.toThrow();
    expect(f.clears()).toBe(0);
  });

  test("stop() unsubscribes the visibility handler", () => {
    const f = fakeEnv({ visible: false });
    const stop = watchAppBadgeClear(f.env);
    stop();
    f.setVisible(true);
    expect(f.clears()).toBe(0);
    expect(f.handlerCount()).toBe(0);
  });

  test("a rejected clear is swallowed (best-effort)", async () => {
    let called = 0;
    const env: AppBadgeEnv = {
      clearAppBadge: () => {
        called++;
        return Promise.reject(new Error("nope"));
      },
      isVisible: () => true,
      onVisible: () => () => {},
    };
    watchAppBadgeClear(env);
    // Let the rejection settle; an unhandled rejection would fail the test run.
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toBe(1);
  });
});
