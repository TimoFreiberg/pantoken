import { afterEach, describe, expect, test } from "bun:test";
import { isDesktopShell, requestDockAttention } from "./desktop.js";

// desktop.ts reads window.__TAURI_INTERNALS__ directly. bun:test runs without a
// DOM, so window is undefined by default — isDesktopShell() is false there.
// For the "in shell" cases we install a minimal window global and tear it down
// after each test so the "no window" baseline holds for the next run.

afterEach(() => {
  // @ts-expect-error — deleting a possibly-absent global is fine at runtime.
  delete globalThis.window;
});

/** Minimal invoke spy: records calls and resolves/rejects as configured. */
function makeInvokeSpy(opts: { reject?: boolean } = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return opts.reject
      ? Promise.reject(new Error("command not registered"))
      : Promise.resolve(undefined);
  };
  return { invoke, calls };
}

describe("isDesktopShell", () => {
  test("returns false when window is undefined (browser-less test env)", () => {
    // @ts-expect-error — ensure no leftover window from a prior test.
    delete globalThis.window;
    expect(isDesktopShell()).toBe(false);
  });

  test("returns false when __TAURI_INTERNALS__ is absent", () => {
    globalThis.window = {} as unknown as typeof globalThis.window;
    expect(isDesktopShell()).toBe(false);
  });

  test("returns true when __TAURI_INTERNALS__ is present", () => {
    const { invoke } = makeInvokeSpy();
    globalThis.window = {
      __TAURI_INTERNALS__: { invoke },
    } as unknown as typeof globalThis.window;
    expect(isDesktopShell()).toBe(true);
  });
});

describe("requestDockAttention", () => {
  test("is a no-op (invoke not called) when __TAURI_INTERNALS__ is undefined", () => {
    // @ts-expect-error — ensure no leftover window from a prior test.
    delete globalThis.window;
    expect(() => requestDockAttention()).not.toThrow();
  });

  test("calls invoke('request_dock_attention') with no args when in a desktop shell", () => {
    const { invoke, calls } = makeInvokeSpy();
    globalThis.window = {
      __TAURI_INTERNALS__: { invoke },
    } as unknown as typeof globalThis.window;

    requestDockAttention();

    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe("request_dock_attention");
    expect(calls[0]!.args).toBeUndefined();
  });

  test("swallows a rejected invoke (best-effort, never throws)", async () => {
    const { invoke, calls } = makeInvokeSpy({ reject: true });
    globalThis.window = {
      __TAURI_INTERNALS__: { invoke },
    } as unknown as typeof globalThis.window;

    // Should not throw synchronously, and the rejected promise should be
    // caught internally (no unhandled rejection).
    expect(() => requestDockAttention()).not.toThrow();
    // Let the microtask queue drain so the .catch handler runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
  });
});
