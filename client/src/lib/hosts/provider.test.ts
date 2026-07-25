import { describe, expect, test } from "bun:test";
import { createFakeHostProvider, createSingleHostProvider } from "./provider.js";
import type { NativeHostDescriptor } from "./types.js";

// The FakeHostProvider and DevHostProvider test sections (~450 lines) were cut:
// they tested the test double's internal plumbing (driveState, connectHost,
// addProfile round-trips) which verifies nothing about the product. Two groups
// were kept (AC.6):

function descriptor(
  id: string,
  overrides: Partial<NativeHostDescriptor> = {},
): NativeHostDescriptor {
  return {
    id,
    kind: "remote",
    label: `Host ${id}`,
    subtitle: "",
    state: "awaitingAcknowledgement",
    wsUrl: `ws://127.0.0.1:9000/${id}`,
    ...overrides,
  };
}

// ── SingleHostProvider smoke test ────────────────────────────────────────────

describe("SingleHostProvider", () => {
  test("returns one local descriptor with sane defaults", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    const hosts = await provider.listHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].id).toBe("local");
    expect(hosts[0].kind).toBe("local");
    expect(hosts[0].state).toBe("ready");
    expect(hosts[0].wsUrl).toBe("ws://127.0.0.1:8787/ws");
    expect(provider.supportsMultiHost()).toBe(false);
  });
});

// ── FakeHostProvider: acknowledgeRisk fingerprint validation (AC.6) ──────────
// The fake's acknowledgeRisk enforces a fingerprint-match contract that dependent
// tests (hosts.svelte, e2e risk flows) rely on. A bug here would surface as
// mysterious failures in those tests, not a clear fingerprint-mismatch error.

describe("FakeHostProvider: acknowledgeRisk validation", () => {
  test("acknowledgeRisk validates fingerprint and records it", async () => {
    const { provider, setPendingRisks } = createFakeHostProvider([
      descriptor("docker-1"),
    ]);
    setPendingRisks("docker-1", [
      {
        id: "ephemeral-1",
        kind: "ephemeralData",
        fingerprint: "fp-aaa",
        title: "Ephemeral data",
        explanation: "Container recreation may lose data.",
        consequences: "Pantoken runtime/session state may be lost.",
        continueLabel: "Allow ephemeral",
      },
    ]);

    await provider.acknowledgeRisk("docker-1", "ephemeral-1", "fp-aaa");
    // No throw means accepted.
  });

  test("acknowledgeRisk throws on fingerprint mismatch", async () => {
    const { provider, setPendingRisks } = createFakeHostProvider([
      descriptor("docker-1"),
    ]);
    setPendingRisks("docker-1", [
      {
        id: "root-1",
        kind: "rootExecution",
        fingerprint: "fp-original",
        title: "Running as root",
        explanation: "x",
        consequences: "y",
        continueLabel: "Allow root",
      },
    ]);

    await expect(
      provider.acknowledgeRisk("docker-1", "root-1", "fp-changed"),
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  test("acknowledgeRisk throws for unknown risk id", async () => {
    const { provider } = createFakeHostProvider([descriptor("docker-1")]);
    await expect(
      provider.acknowledgeRisk("docker-1", "nope", "fp"),
    ).rejects.toThrow(/no pending risk/);
  });
});
