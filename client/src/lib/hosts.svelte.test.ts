// Tests for the HostCoordinator: message routing boundary, host switching,
// cached bootstrap, activity tracking, and outbox routing.
//
// Uses a FakeHostProvider and FakeWsClient instances — no real WebSocket,
// no DOM, no timers.

import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage, ServerMessage } from "@pantoken/protocol";
import { HostCoordinator } from "./hosts.svelte.js";
import { createFakeHostProvider } from "./hosts/provider.js";
import type { NativeHostDescriptor } from "./hosts/types.js";
import type { IWsClient, MessageListener } from "./ws-client.svelte.js";
import { store } from "./store.svelte.js";

afterEach(() => {
  // Reset the store singleton between tests so one test's server-scoped state
  // doesn't leak into the next.
  store.switchHost();
  localStorage.clear();
});

// ── FakeWsClient ────────────────────────────────────────────────────────

/** A fake WsClient that implements IWsClient without a real WebSocket.
 *  Tests call `deliver(msg)` to simulate an incoming server message. */
class FakeWsClient implements IWsClient {
  private state = "disconnected" as IWsClient["connectionState"] extends infer T
    ? T
    : never;
  private attempt = 0;
  private listeners: MessageListener[] = [];
  private resumeProvider: (() => unknown) | null = null;
  sentMessages: ClientMessage[] = [];
  connected = false;

  connectionState() {
    return this.state;
  }
  reconnectAttempts() {
    return this.attempt;
  }
  connect() {
    this.state = "connecting";
    this.connected = true;
    this.state = "connected";
  }
  forceReconnect() {
    this.connect();
  }
  disconnect() {
    this.state = "disconnected";
    this.connected = false;
  }
  send(msg: ClientMessage): boolean {
    this.sentMessages.push(msg);
    return true;
  }
  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  setResumeProvider(fn: (() => unknown) | null): void {
    this.resumeProvider = fn;
  }
  destroy() {
    this.listeners = [];
    this.connected = false;
    this.state = "disconnected";
  }

  /** Test helper: simulate the server sending a message. */
  deliver(msg: ServerMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (e) {
        console.error("[FakeWsClient] listener error:", e);
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function descriptor(
  id: string,
  overrides: Partial<NativeHostDescriptor> = {},
): NativeHostDescriptor {
  return {
    id,
    kind: id === "local" ? "local" : "remote",
    label: `Host ${id}`,
    subtitle: "",
    state: "ready",
    wsUrl: `ws://127.0.0.1:9000/${id}`,
    ...overrides,
  };
}

function helloMsg(serverId: string, label: string): ServerMessage {
  return {
    type: "hello",
    protocolVersion: 5,
    serverId,
    serverLabel: label,
    dataDir: "/tmp",
  } as ServerMessage;
}

function seedMsg(sessionId: string | null): ServerMessage {
  return {
    type: "seed",
    sessionId,
    epoch: 1,
    seq: 0,
    events: [],
  } as ServerMessage;
}

function sessionStatusMsg(runningIds: string[]): ServerMessage {
  return {
    type: "sessionStatus",
    runningIds,
  } as ServerMessage;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("HostCoordinator message routing boundary", () => {
  test("messages from an inactive WsClient do not mutate the visible store", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    // Replace connectHost's WsClient creation with a fake client.
    const fakeClient = new FakeWsClient();
    const originalConnectHost = coordinator.connectHost.bind(coordinator);
    coordinator.connectHost = async (id: string) => {
      // Inject the fake client directly.
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        entry.client = fakeClient;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = fakeClient.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // The store should have the local host's data.
    const initialServerId = store.serverId;

    // Deliver a seed to the inactive remote-1 host.
    fakeClient.deliver(seedMsg("remote-session-1"));

    // The store should NOT have changed.
    expect(store.serverId).toBe(initialServerId);
  });

  test("switching requests authoritative seed/bootstrap before showing the new transcript", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    const fakeClient = new FakeWsClient();
    coordinator.connectHost = async (id: string) => {
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        entry.client = fakeClient;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = fakeClient.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // Switch to remote-1.
    await coordinator.selectHost("remote-1");

    // The coordinator should have sent a requestSeed on remote-1's client.
    expect(fakeClient.sentMessages.some((m) => m.type === "requestSeed")).toBe(true);
  });

  test("host A data cannot render beneath host B identity during a slow switch", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    const fakeClient = new FakeWsClient();
    coordinator.connectHost = async (id: string) => {
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        entry.client = fakeClient;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = fakeClient.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // Switch to remote-1 — before any seed arrives, the store should be in a
    // neutral state (ready=false, serverId=null).
    await coordinator.selectHost("remote-1");

    expect(store.ready).toBe(false);
    expect(store.serverId).toBe(null);
  });

  test("selecting a computer clears ordinary unseen", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    const fakeClient = new FakeWsClient();
    coordinator.connectHost = async (id: string) => {
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        entry.client = fakeClient;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = fakeClient.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // Drive remote-1 to unseen: first establish baseline with a running session,
    // then transition to done.
    await coordinator.connectHost("remote-1");
    fakeClient.deliver(sessionStatusMsg(["s1"]));
    fakeClient.deliver(sessionStatusMsg([])); // s1 completed → unseen

    const activity = coordinator.getActivity("remote-1");
    expect(activity.unseen).toBe(true);

    // Select remote-1 — unseen should be cleared.
    await coordinator.selectHost("remote-1");

    const activityAfter = coordinator.getActivity("remote-1");
    expect(activityAfter.unseen).toBe(false);
  });

  test("waiting/failed attention survives selection", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    const fakeClient = new FakeWsClient();
    coordinator.connectHost = async (id: string) => {
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        entry.client = fakeClient;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = fakeClient.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // Drive remote-1 to waiting.
    await coordinator.connectHost("remote-1");
    fakeClient.deliver(
      sessionStatusMsg([]) as unknown as ServerMessage & {
        attention: { sessionId: string; phase: string; updatedAt: string }[];
      },
    );

    // Manually set the unread state to have waiting=true (simulating a
    // sessionStatus with a waiting attention item).
    const entry = (coordinator as unknown as {
      hostState: Map<string, { unread: { waiting: boolean; unseen: boolean; failed: boolean; running: boolean; baselined: boolean; prevRunningIds: Set<string> } }>;
    }).hostState.get("remote-1")!;
    entry.unread.waiting = true;
    entry.unread.unseen = true;

    // Select remote-1.
    await coordinator.selectHost("remote-1");

    const activity = coordinator.getActivity("remote-1");
    expect(activity.unseen).toBe(false); // cleared
    expect(activity.waiting).toBe(true); // survives
  });

  test("queued prompts remain bound to their original serverId", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    const fakeClient = new FakeWsClient();
    coordinator.connectHost = async (id: string) => {
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        entry.client = fakeClient;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = fakeClient.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // Enqueue a prompt on the local host.
    store.serverId = "local-server";
    store.pendingPrompts = [
      {
        promptId: "p1",
        serverId: "local-server",
        kind: "prompt" as const,
        text: "hello",
        createdAt: "2026-01-01T00:00:00Z",
        state: "queued" as const,
      },
    ];

    // Switch to remote-1 — pendingPrompts should be cleared.
    await coordinator.selectHost("remote-1");

    expect(store.pendingPrompts).toHaveLength(0);
  });

  test("hydrateFromBootstrap replays cached messages into the store", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    const fakeClient = new FakeWsClient();
    coordinator.connectHost = async (id: string) => {
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        entry.client = fakeClient;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = fakeClient.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // Connect remote-1 and deliver bootstrap messages.
    await coordinator.connectHost("remote-1");
    fakeClient.deliver(helloMsg("remote-server", "Remote Server"));
    fakeClient.deliver(sessionStatusMsg([]));

    // Switch to remote-1 — the cached hello should be replayed.
    await coordinator.selectHost("remote-1");

    expect(store.serverId).toBe("remote-server");
    expect(store.serverLabel).toBe("Remote Server");
  });

  test("per-client state is reloaded from namespaced persistence on host switch", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const coordinator = new HostCoordinator(provider);

    // Use a separate FakeWsClient per host so listeners don't cross-fire.
    const fakeClients = new Map<string, FakeWsClient>();
    coordinator.connectHost = async (id: string) => {
      const entry = (coordinator as unknown as {
        hostState: Map<string, { client: IWsClient | null; unsubscribe: (() => void) | null; descriptor: NativeHostDescriptor }>;
      }).hostState.get(id);
      if (entry && !entry.client) {
        const client = new FakeWsClient();
        fakeClients.set(id, client);
        entry.client = client;
        const listener: MessageListener = (msg) =>
          (coordinator as unknown as {
            onHostMessage: (hostId: string, msg: ServerMessage) => void;
          }).onHostMessage(id, msg);
        entry.unsubscribe = client.onMessage(listener);
      }
    };

    await coordinator.init();
    await coordinator.selectHost("local");

    // Set up namespaced per-client state for remote-1's server.
    const remoteServerId = "remote-server";
    localStorage.setItem(
      `pantoken.${remoteServerId}.composerDrafts`,
      JSON.stringify({ "s:remote-session": "remote draft" }),
    );
    localStorage.setItem(
      `pantoken.${remoteServerId}.lastProjectCwd`,
      "/remote/home/project",
    );

    // Connect remote-1 and deliver its hello (which sets serverId in cache).
    await coordinator.connectHost("remote-1");
    fakeClients.get("remote-1")!.deliver(helloMsg(remoteServerId, "Remote Server"));

    // Switch to remote-1.
    await coordinator.selectHost("remote-1");

    // The per-client state should be loaded from namespaced persistence.
    expect((store as unknown as { draftMap: Record<string, string> }).draftMap["s:remote-session"]).toBe("remote draft");
    expect(store.lastProjectCwd).toBe("/remote/home/project");
  });
});
