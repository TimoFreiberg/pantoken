// Tests for the WsClient class: URL resolution, send-gating, and message
// listener unsubscribe. The 3 instance-independence tests and trivial wiring
// tests (disconnected-at-start, connect-creates-socket, disconnect-sets-state)
// were cut — they verified basic OOP encapsulation, not logic.
//
// Known gap: the valuable logic (reconnect/backoff/heartbeat in the 480-line
// impl) is untested today. See the TODO in ws-client.svelte.ts.

import { afterEach, describe, expect, test } from "vitest";
import { WsClient } from "./ws-client.svelte.js";

// ── Mock WebSocket ─────────────────────────────────────────────────────

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

function mockWebSocket(): void {
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
    MockWebSocket as unknown as typeof WebSocket;
}

function restoreWebSocket(): void {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    originalWebSocket;
}

const HELLO = JSON.stringify({
  type: "hello",
  protocolVersion: 5,
  serverId: "test-server",
  serverLabel: "Test",
  dataDir: "/tmp",
});

describe("WsClient", () => {
  afterEach(() => {
    restoreWebSocket();
  });

  test("with a URL function, re-resolves on each connect", () => {
    mockWebSocket();
    let urlCount = 0;
    const client = new WsClient(() => {
      urlCount++;
      return `ws://127.0.0.1:${9000 + urlCount}/ws`;
    });
    client.connect();
    expect(MockWebSocket.instances[0].url).toBe("ws://127.0.0.1:9001/ws");
    client.disconnect();

    client.connect();
    expect(MockWebSocket.instances[1].url).toBe("ws://127.0.0.1:9002/ws");
    client.destroy();
  });

  test("send returns false when socket is not open", () => {
    mockWebSocket();
    const client = new WsClient("ws://127.0.0.1:9999/ws");
    expect(client.send({ type: "ping" })).toBe(false);
    client.destroy();
  });

  test("send returns true and writes to the socket when open", () => {
    mockWebSocket();
    const client = new WsClient("ws://127.0.0.1:9999/ws");
    client.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();
    mock.sentMessages.length = 0;
    expect(client.send({ type: "ping" })).toBe(true);
    expect(mock.sentMessages).toHaveLength(1);
    expect(JSON.parse(mock.sentMessages[0])).toEqual({ type: "ping" });
    client.destroy();
  });

  test("onMessage listeners receive parsed server messages", () => {
    mockWebSocket();
    const client = new WsClient("ws://127.0.0.1:9999/ws");
    const received: string[] = [];
    client.onMessage((msg) => received.push(msg.type));
    client.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();
    mock.simulateMessage(HELLO);
    expect(received).toContain("hello");
    expect(client.connectionState()).toBe("connected");
    client.destroy();
  });

  test("onMessage returns an unsubscribe function", () => {
    mockWebSocket();
    const client = new WsClient("ws://127.0.0.1:9999/ws");
    const received: string[] = [];
    const unsub = client.onMessage((msg) => received.push(msg.type));
    client.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();
    mock.simulateMessage(HELLO);
    expect(received).toHaveLength(1);
    unsub();
    mock.simulateMessage(JSON.stringify({ type: "pong" }));
    expect(received).toHaveLength(1); // listener was removed
    client.destroy();
  });
});
