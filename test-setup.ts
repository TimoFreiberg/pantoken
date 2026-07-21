// Test preload: polyfill Svelte 5 runes and minimal DOM globals so .svelte.ts
// files can be imported and tested under `bun test` without the Svelte compiler
// or a full DOM environment.
//
// In Svelte 5, `$state(x)` creates a reactive signal backed by a getter/setter.
// For testing purposes, a plain mutable value is sufficient — the reactive
// re-rendering isn't needed, only the read/write semantics.
//
// This file is loaded via bunfig.toml [test].preload before any test runs.

// ── Svelte 5 rune polyfills ────────────────────────────────────────────

// $state<T>(initial: T): T — returns the initial value as a plain field.
// Writes to the field (this._state = x) work normally; reads return the value.
(globalThis as { $state?: <T>(initial: T) => T }).$state = <T>(
  initial: T,
): T => initial;

// $derived<T>(fn: () => T): T — evaluates the function once and returns the
// value. Not reactive in tests, but sufficient for read-only derived state.
(globalThis as { $derived?: <T>(fn: () => T) => T }).$derived = <T>(
  fn: () => T,
): T => fn();

// $effect(fn: () => void | (() => void)): void — no-op in tests. Effects are
// for reactive side-effects that re-run on dependency changes; tests don't
// need them.
(globalThis as { $effect?: (fn: () => unknown) => void }).$effect = () => {};

// ── Minimal DOM globals ────────────────────────────────────────────────
// WsClient references `document.visibilityState`, `document.addEventListener`,
// `window.addEventListener`, etc. In Bun's test environment these don't exist
// by default. We provide a minimal mock that's sufficient for unit testing.

if (typeof globalThis.document === "undefined") {
  const listeners = new Map<string, Set<EventListener>>();
  const mockDocument = {
    visibilityState: "visible" as string,
    hidden: false as boolean,
    addEventListener: (type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  (globalThis as { document: typeof mockDocument }).document = mockDocument;
}

if (typeof globalThis.window === "undefined") {
  const listeners = new Map<string, Set<EventListener>>();
  const mockWindow = {
    location: {
      protocol: "http:",
      host: "127.0.0.1:8787",
      search: "",
      href: "http://127.0.0.1:8787/",
    },
    addEventListener: (type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      const type = (event as { type?: string }).type;
      if (!type) return true;
      const set = listeners.get(type);
      if (set) for (const l of set) l(event);
      return true;
    },
  };
  (globalThis as { window: typeof mockWindow }).window = mockWindow;
  // `location` is a global alias for `window.location` in browsers.
  (globalThis as { location: typeof mockWindow.location }).location =
    mockWindow.location;
}

// localStorage polyfill for tests that import modules reading/writing it.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const localStorageMock: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as { localStorage: Storage }).localStorage = localStorageMock;
}

// history polyfill (getToken calls history.replaceState).
if (typeof globalThis.history === "undefined") {
  (globalThis as { history: { replaceState: () => void } }).history = {
    replaceState: () => {},
  };
}

// Vite build-time defines (build-info.ts references __BUILD_HASH__ etc.).
// In dev these are replaced by vite.config.ts `define`; in tests they're absent.
if (typeof (globalThis as { __BUILD_HASH__?: string }).__BUILD_HASH__ === "undefined") {
  (globalThis as { __BUILD_HASH__: string }).__BUILD_HASH__ = "test-hash";
}
if (typeof (globalThis as { __BUILD_FULL_HASH__?: string }).__BUILD_FULL_HASH__ === "undefined") {
  (globalThis as { __BUILD_FULL_HASH__: string }).__BUILD_FULL_HASH__ = "test-full-hash";
}
if (typeof (globalThis as { __BUILD_DATE__?: string }).__BUILD_DATE__ === "undefined") {
  (globalThis as { __BUILD_DATE__: string }).__BUILD_DATE__ = "2026-01-01";
}
if (typeof (globalThis as { __BUILD_TAG__?: string }).__BUILD_TAG__ === "undefined") {
  (globalThis as { __BUILD_TAG__: string }).__BUILD_TAG__ = "";
}
