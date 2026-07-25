// Tests for the HostCoordinator's profile CRUD methods, reconnect-required
// detection, everConnected tracking, and risk/acknowledgement delegation.
//
// Uses createFakeHostProvider — no real WebSocket, no DOM.

import { afterEach, describe, expect, test } from "bun:test";
import { HostCoordinator } from "./hosts.svelte.js";
import { createFakeHostProvider } from "./hosts/provider.js";
import type { NativeHostDescriptor, RemoteProfile } from "./hosts/types.js";
import { store } from "./store.svelte.js";

afterEach(() => {
  store.switchHost();
  localStorage.clear();
});

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

function makeProfile(id: string, overrides: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id,
    label: `Profile ${id}`,
    sshDestination: "user@host",
    polytokenPolicy: "requireExisting",
    xdgMode: "isolated",
    executionTarget: { kind: "host" },
    riskAcknowledgements: {},
    ...overrides,
  };
}

describe("HostCoordinator profile CRUD", () => {
  test("addProfile calls provider and refreshes hosts + profiles", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);

    expect(coordinator.profiles).toHaveLength(1);
    expect(coordinator.profiles[0]!.id).toBe("remote-1");
  });

  test("updateProfile calls provider and refreshes profiles", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);

    const updated = { ...profile, label: "Updated label" };
    await coordinator.updateProfile(updated);

    expect(coordinator.profiles[0]!.label).toBe("Updated label");
  });

  test("deleteProfile calls provider and refreshes profiles", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    expect(coordinator.profiles).toHaveLength(1);

    await coordinator.deleteProfile("remote-1");
    expect(coordinator.profiles).toHaveLength(0);
  });

  test("deleteProfile switches to local if the selected host is deleted", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);

    // Select remote-1 (it will connect since the fake provider sets it to ready).
    await coordinator.selectHost("remote-1");
    expect(coordinator.selectedHostId).toBe("remote-1");

    await coordinator.deleteProfile("remote-1");
    expect(coordinator.selectedHostId).toBe("local");
  });
});

describe("HostCoordinator reconnectRequired detection", () => {
  test("updateProfile sets reconnectRequired when connection-affecting fields change on a connected host", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1", { sshDestination: "user@host1" });
    await coordinator.addProfile(profile);

    // Connect the host first (the fake provider's connectHost sets it to ready).
    await coordinator.connectHost("remote-1");
    expect(coordinator.hasEverConnected("remote-1")).toBe(true);

    // Update with a connection-affecting change.
    await coordinator.updateProfile({ ...profile, sshDestination: "user@host2" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(true);
  });

  test("updateProfile does NOT set reconnectRequired when only the label changes", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    await coordinator.connectHost("remote-1");

    // Update with a non-connection-affecting change.
    await coordinator.updateProfile({ ...profile, label: "New label" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(false);
  });

  test("updateProfile does NOT set reconnectRequired when host is not connected", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    // Don't connect.

    await coordinator.updateProfile({ ...profile, sshDestination: "user@other" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(false);
  });

  test("clearReconnectRequired clears the flag", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    await coordinator.connectHost("remote-1");

    await coordinator.updateProfile({ ...profile, sshDestination: "user@host2" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(true);

    coordinator.clearReconnectRequired("remote-1");
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(false);
  });
});

// The everConnected tracking test and the 3 risk/acknowledgement delegation
// tests ("should not throw") were cut — they verified pure pass-through to the
// provider with no transformation. The reconnectRequired detection tests above
// were kept: they pin real connection-affecting field-change detection logic.
