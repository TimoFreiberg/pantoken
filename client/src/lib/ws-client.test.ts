// Tests for the WsClient class: verifies instance independence and the
// compatibility delegation layer in ws.svelte.ts.
//
// WsClient uses $state (Svelte runes) and WebSocket, so we need a mock
// WebSocket. The mock simulates the open/message/close lifecycle without
// a real server.

import { afterEach, describe, expect, test } from "bun:test";
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

  /** Test helper: simulate the server accepting the connection. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** Test helper: simulate the server sending a message. */
  simulateMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  /** Test helper: simulate the server closing the connection. */
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
}

// Patch global WebSocket before each test.
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

// ── Tests ──────────────────────────────────────────────────────────────

describe("WsClient", () => {
  afterEach(() => {
    restoreWebSocket();
  });

  test("starts in disconnected state", () => {
    mockWebSocket();
    const client = new WsClient("ws://127.0.0.1:9999/ws");
    expect(client.connectionState()).toBe("disconnected");
    client.destroy();
  });

  test("connect creates a WebSocket with the given URL", () => {
    mockWebSocket();
    const client = new WsClient("ws://127.0.0.1:9999/ws");
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe("ws://127.0.0.1:9999/ws");
    expect(client.connectionState()).toBe("connecting");
    client.destroy();
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
    // The hello is sent on open; clear it so we can check our send.
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
    // Simulate a hello message (which flips state to connected).
    mock.simulateMessage(
      JSON.stringify({
        type: "hello",
        protocolVersion: 5,
        serverId: "test-server",
        serverLabel: "Test",
        dataDir: "/tmp",
      }),
    );
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
    mock.simulateMessage(
      JSON.stringify({
        type: "hello",
        protocolVersion: 5,
        serverId: "s1",
        serverLabel: "Test",
        dataDir: "/tmp",
      }),
    );
    expect(received).toHaveLength(1);
    unsub();
    mock.simulateMessage(JSON.stringify({ type: "pong" }));
    expect(received).toHaveLength(1); // listener was removed
    client.destroy();
  });

  test("disconnect sets state to disconnected", () => {
    mockWebSocket();
    const client = new WsClient("ws://127.0.0.1:9999/ws");
    client.connect();
    client.disconnect();
    expect(client.connectionState()).toBe("disconnected");
    client.destroy();
  });

  test("two WsClient instances have independent state", () => {
    mockWebSocket();
    const clientA = new WsClient("ws://127.0.0.1:9001/ws");
    const clientB = new WsClient("ws://127.0.0.1:9002/ws");

    clientA.connect();
    clientB.connect();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[0].url).toBe("ws://127.0.0.1:9001/ws");
    expect(MockWebSocket.instances[1].url).toBe("ws://127.0.0.1:9002/ws");

    // Open only clientA + simulate the server's hello response.
    const mockA = MockWebSocket.instances[0];
    mockA.simulateOpen();
    mockA.simulateMessage(
      JSON.stringify({
        type: "hello",
        protocolVersion: 5,
        serverId: "server-A",
        serverLabel: "A",
        dataDir: "/tmp",
      }),
    );
    expect(clientA.connectionState()).toBe("connected");
    // ClientB is still connecting.
    expect(clientB.connectionState()).toBe("connecting");

    clientA.destroy();
    clientB.destroy();
  });

  test("closing one WsClient does not alter another's state", () => {
    mockWebSocket();
    const clientA = new WsClient("ws://127.0.0.1:9001/ws");
    const clientB = new WsClient("ws://127.0.0.1:9002/ws");

    clientA.connect();
    clientB.connect();

    const mockA = MockWebSocket.instances[0];
    const mockB = MockWebSocket.instances[1];

    mockA.simulateOpen();
    mockA.simulateMessage(
      JSON.stringify({
        type: "hello",
        protocolVersion: 5,
        serverId: "server-A",
        serverLabel: "A",
        dataDir: "/tmp",
      }),
    );
    mockB.simulateOpen();
    mockB.simulateMessage(
      JSON.stringify({
        type: "hello",
        protocolVersion: 5,
        serverId: "server-B",
        serverLabel: "B",
        dataDir: "/tmp",
      }),
    );

    expect(clientA.connectionState()).toBe("connected");
    expect(clientB.connectionState()).toBe("connected");

    // Disconnect clientA.
    clientA.disconnect();
    expect(clientA.connectionState()).toBe("disconnected");
    // ClientB is still connected.
    expect(clientB.connectionState()).toBe("connected");

    clientA.destroy();
    clientB.destroy();
  });

  test("two WsClient instances have independent message listeners", () => {
    mockWebSocket();
    const clientA = new WsClient("ws://127.0.0.1:9001/ws");
    const clientB = new WsClient("ws://127.0.0.1:9002/ws");

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    clientA.onMessage((msg) => receivedA.push(msg.type));
    clientB.onMessage((msg) => receivedB.push(msg.type));

    clientA.connect();
    clientB.connect();

    const mockA = MockWebSocket.instances[0];
    const mockB = MockWebSocket.instances[1];

    mockA.simulateOpen();
    mockB.simulateOpen();

    // Send a hello to A only.
    mockA.simulateMessage(
      JSON.stringify({
        type: "hello",
        protocolVersion: 5,
        serverId: "server-A",
        serverLabel: "A",
        dataDir: "/tmp",
      }),
    );

    expect(receivedA).toContain("hello");
    expect(receivedB).toHaveLength(0); // B didn't receive A's message

    clientA.destroy();
    clientB.destroy();
  });
});
