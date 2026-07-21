// resolveWsUrl is the pure core of buildWsUrl. Split out so the `?ws=` loopback
// override + the env-override + default derivation are unit-testable without a
// DOM. The security-critical invariant: a `?ws=` param pointing off-loopback
// (e.g. ws://attacker.com/ws) MUST be rejected — it would exfiltrate the
// entire protocol stream including auth tokens (getToken()) and prompt
// content.

import { describe, expect, test } from "bun:test";
import { resolveWsUrl } from "./ws-url.js";
import * as wsCompat from "./ws.svelte.js";
import { WsClient } from "./ws-client.svelte.js";

// ── Mock WebSocket for delegation tests ─────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sentMessages.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  simulateMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const originalWebSocket = globalThis.WebSocket;

/** Ensure window/document/location exist for the delegation tests — other test
 *  files (desktop.test.ts) may have deleted globalThis.window. */
function ensureDomGlobals(): void {
  if (typeof globalThis.window === "undefined") {
    (globalThis as { window: unknown }).window = {
      location: {
        protocol: "http:",
        host: "127.0.0.1:8787",
        search: "",
        href: "http://127.0.0.1:8787/",
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
  }
  if (typeof globalThis.document === "undefined") {
    (globalThis as { document: unknown }).document = {
      visibilityState: "visible",
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
  if (typeof globalThis.location === "undefined") {
    (globalThis as { location: unknown }).location = {
      protocol: "http:",
      host: "127.0.0.1:8787",
      search: "",
      href: "http://127.0.0.1:8787/",
    };
  }
}

describe("resolveWsUrl (pure)", () => {
  test("env override wins over everything", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://127.0.0.1:9999/ws" };
    expect(resolveWsUrl(loc, "ws://override:1234")).toBe("ws://override:1234");
  });

  test("?ws= loopback override is accepted", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://127.0.0.1:9999/ws" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:9999/ws");
  });

  test("?ws= localhost override is accepted", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://localhost:9999/ws" };
    expect(resolveWsUrl(loc)).toBe("ws://localhost:9999/ws");
  });

  test("?ws= IPv6 loopback [::1] override is accepted", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://[::1]:9999/ws" };
    expect(resolveWsUrl(loc)).toBe("ws://[::1]:9999/ws");
  });

  test("?ws= off-loopback is REJECTED → falls back to default (security)", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://attacker.com/ws" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("?ws= off-loopback with same hostname-as-path is rejected", () => {
    // A URL like ws://evil.example/127.0.0.1 must NOT trick the check — the
    // hostname is evil.example, not loopback.
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://evil.example/127.0.0.1" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("?ws= not-a-url is rejected → default", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=not-a-url" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("no ?ws= → default derivation (http → ws)", () => {
    const loc = { protocol: "http:", host: "app.example:8787", search: "" };
    expect(resolveWsUrl(loc)).toBe("ws://app.example:8787/ws");
  });

  test("no ?ws= → default derivation (https → wss)", () => {
    const loc = { protocol: "https:", host: "app.example:8787", search: "" };
    expect(resolveWsUrl(loc)).toBe("wss://app.example:8787/ws");
  });

  test("empty ?ws= → default derivation", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("other query params present → ?ws= still read", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?foo=bar&ws=ws://127.0.0.1:9999/ws&baz=1" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:9999/ws");
  });
});

describe("ws.svelte.ts compatibility delegation", () => {
  test("connectionState() reflects the singleton's state", () => {
    ensureDomGlobals();
    // The singleton starts disconnected (no connect() called).
    expect(wsCompat.connectionState()).toBe("disconnected");
  });

  test("connect() delegates to the singleton WsClient", () => {
    ensureDomGlobals();
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
    try {
      wsCompat.connect();
      // The singleton should have created a WebSocket.
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
      wsCompat.disconnect();
    } finally {
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
        originalWebSocket;
    }
  });

  test("send() delegates to the singleton WsClient", () => {
    ensureDomGlobals();
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
    try {
      wsCompat.connect();
      const mock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      mock.simulateOpen();
      mock.sentMessages.length = 0; // clear the hello
      expect(wsCompat.send({ type: "ping" })).toBe(true);
      expect(mock.sentMessages).toHaveLength(1);
      expect(JSON.parse(mock.sentMessages[0])).toEqual({ type: "ping" });
      wsCompat.disconnect();
    } finally {
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
        originalWebSocket;
    }
  });

  test("onMessage() delegates to the singleton WsClient", () => {
    ensureDomGlobals();
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
    try {
      const received: string[] = [];
      const unsub = wsCompat.onMessage((msg) => received.push(msg.type));
      wsCompat.connect();
      const mock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      mock.simulateOpen();
      mock.simulateMessage(
        JSON.stringify({
          type: "hello",
          protocolVersion: 5,
          serverId: "delegation-test",
          serverLabel: "Test",
          dataDir: "/tmp",
        }),
      );
      expect(received).toContain("hello");
      unsub();
      wsCompat.disconnect();
    } finally {
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
        originalWebSocket;
    }
  });
});
