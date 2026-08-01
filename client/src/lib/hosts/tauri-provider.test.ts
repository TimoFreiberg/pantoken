// TauriHostProvider tests — kept tests assert non-trivial value transformation:
// snapshot→descriptor mapping, poll-state error mapping, non-terminal resolution,
// and pending-risk/docker-target mapping. Pure delegation tests were removed.

import { afterEach, describe, expect, test } from "vitest";
import { createTauriHostProvider, HostConnectionError } from "./tauri-provider.js";

afterEach(() => {
  // @ts-expect-error — deleting a possibly-absent global is fine at runtime.
  delete globalThis.window;
});

function installInvoke(responses: Record<string, (() => unknown)[]>) {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string): Promise<unknown> =>
        Promise.resolve(responses[cmd]?.length ? responses[cmd].shift()!() : undefined),
    },
  } as unknown as typeof globalThis.window;
}

/** Install an invoke that rejects with `message` for the given command. */
function installRejectingInvoke(command: string, message: string) {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string): Promise<unknown> => {
        if (cmd === command) return Promise.reject(new Error(message));
        return Promise.resolve(undefined);
      },
    },
  } as unknown as typeof globalThis.window;
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "remote-1",
    kind: "remote",
    label: "My Remote",
    subtitle: "user@host",
    state: "ready",
    wsUrl: "ws://127.0.0.1:12345",
    ...overrides,
  };
}

describe("TauriHostProvider", () => {
  test("listHosts maps snapshots to descriptors (local overlay, Docker subtitle, empty-label fallback)", async () => {
    installInvoke({
      list_hosts: [
        () => [
          snapshot({ id: "local", kind: "local", label: "", subtitle: "", state: "ready", wsUrl: "ws://127.0.0.1:8787/ws" }),
          snapshot({ id: "remote-1", state: "disconnected", wsUrl: undefined }),
          snapshot({ id: "docker-1", label: "Work API", subtitle: "", state: "ready", containerName: "work-api", redactedSshHost: "dev-server" }),
        ],
        () => [snapshot({ id: "local", kind: "local", label: "", subtitle: "", state: "ready" })],
      ],
    });

    const hosts = await createTauriHostProvider(() => "My Mac").listHosts();
    expect(hosts[0]!.label).toBe("My Mac");
    expect(hosts[0]!.subtitle).toBe("This computer");
    expect(hosts[1]!.label).toBe("My Remote");
    expect(hosts[1]!.subtitle).toBe("user@host");
    expect(hosts[1]!.wsUrl).toBeUndefined();
    expect(hosts[2]!.subtitle).toBe("work-api via dev-server");

    // Empty server label → falls back to "This computer".
    const hosts2 = await createTauriHostProvider(() => "").listHosts();
    expect(hosts2[0]!.label).toBe("This computer");
  });

  test("connectHost rejects with HostConnectionError mapping failure fields", async () => {
    installInvoke({
      ensure_remote_host: [() => snapshot({ state: "connecting" })],
      host_state: [() => snapshot({ state: "failed", failureLabel: "SSH authentication failed", failureAction: "Check your SSH key.", failureDetail: "Permission denied" })],
    });

    try {
      await createTauriHostProvider(() => "").connectHost("remote-1");
      expect(false).toBe(true); // Should have thrown.
    } catch (e) {
      expect(e).toBeInstanceOf(HostConnectionError);
      expect((e as HostConnectionError).message).toBe("SSH authentication failed");
      expect((e as HostConnectionError).failureAction).toBe("Check your SSH key.");
      expect((e as HostConnectionError).failureDetail).toBe("Permission denied");
    }
  });

  test("connectHost resolves for non-terminal states; listHosts maps pending risks + isDockerTarget", async () => {
    const risk = { id: "socket-1", kind: "dockerSocket", fingerprint: "fp", title: "Docker socket", explanation: "e", consequences: "c", continueLabel: "Accept" };
    installInvoke({
      ensure_remote_host: [() => snapshot({ state: "preflight" })],
      host_state: [() => snapshot({ state: "awaitingAcknowledgement", preflightPhase: "checkingPersistence", pendingRisks: [risk], containerName: "work-api", redactedSshHost: "dev-server" })],
      list_hosts: [() => [snapshot({ id: "docker-1", state: "awaitingAcknowledgement", preflightPhase: "checkingPersistence", pendingRisks: [risk], containerName: "work-api", redactedSshHost: "dev-server" })]],
    });

    const provider = createTauriHostProvider(() => "");
    // Non-terminal state must resolve (not throw) so the UI can act.
    await expect(provider.connectHost("docker-1")).resolves.toBeUndefined();
    const hosts = await provider.listHosts();
    const dockerHost = hosts.find((h) => h.id === "docker-1");
    expect(dockerHost?.pendingRisks?.[0].kind).toBe("dockerSocket");
    expect(dockerHost?.isDockerTarget).toBe(true);
  });

  test("testSshAndListContainers degrades only for missing-command rejections", async () => {
    const provider = createTauriHostProvider(() => "");

    // Genuinely missing command (build predates registration) → degraded message.
    installRejectingInvoke("test_ssh_and_list_containers", "command test_ssh_and_list_containers not found");
    await expect(provider.testSshAndListContainers("user@host")).rejects.toThrow(
      "Container commands are not available in this build",
    );

    // Real failure (command ran, returned Err) → the actual message propagates.
    installRejectingInvoke("test_ssh_and_list_containers", "SSH connection failed: Connection refused");
    await expect(provider.testSshAndListContainers("user@host")).rejects.toThrow(
      "SSH connection failed: Connection refused",
    );
  });

  test("inspectContainer degrades only for missing-command rejections", async () => {
    const provider = createTauriHostProvider(() => "");

    // Genuinely missing command → degraded message.
    installRejectingInvoke("inspect_container", "command inspect_container not found");
    await expect(provider.inspectContainer("user@host", 22, "work-api")).rejects.toThrow(
      "Container inspection is not available in this build",
    );

    // Real failure → the actual message propagates.
    installRejectingInvoke("inspect_container", "SSH connection failed: Connection refused");
    await expect(provider.inspectContainer("user@host", 22, "work-api")).rejects.toThrow(
      "SSH connection failed: Connection refused",
    );
  });
});
