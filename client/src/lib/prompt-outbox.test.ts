import { describe, test, expect, beforeEach } from "bun:test";
import fakeIndexedDB from "fake-indexeddb";
import FDBKeyRange from "fake-indexeddb/lib/FDBKeyRange";
import {
  savePendingPrompt,
  loadPendingPrompts,
  deletePendingPrompt,
  _resetDbCache,
  _clearAllPrompts,
  type PendingPrompt,
} from "./prompt-outbox";

// Set up the fake IndexedDB globals before any test runs.
(globalThis as any).indexedDB = fakeIndexedDB;
(globalThis as any).IDBKeyRange = FDBKeyRange;

function makePrompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    promptId: "p1",
    serverId: "srv1",
    kind: "prompt",
    text: "hello",
    createdAt: "2025-01-01T00:00:00Z",
    state: "queued",
    ...overrides,
  };
}

describe("prompt-outbox", () => {
  beforeEach(async () => {
    _resetDbCache();
    await _clearAllPrompts();
  });

  test("save → load roundtrip", async () => {
    const prompt = makePrompt({ promptId: "roundtrip-1" });
    await savePendingPrompt(prompt);
    const loaded = await loadPendingPrompts("srv1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].promptId).toBe("roundtrip-1");
    expect(loaded[0].text).toBe("hello");
  });

  test("load filters by serverId", async () => {
    await savePendingPrompt(makePrompt({ promptId: "a", serverId: "srv1" }));
    await savePendingPrompt(makePrompt({ promptId: "b", serverId: "srv2" }));
    const loaded = await loadPendingPrompts("srv1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].promptId).toBe("a");
  });

  test("delete removes a prompt", async () => {
    await savePendingPrompt(makePrompt({ promptId: "del-1" }));
    await deletePendingPrompt("del-1");
    const loaded = await loadPendingPrompts("srv1");
    expect(loaded).toHaveLength(0);
  });

  test("sending → queued rewrite on load (crash recovery)", async () => {
    // A prompt that was mid-send when the page crashed should be re-queued.
    await savePendingPrompt(
      makePrompt({ promptId: "crash-1", state: "sending" }),
    );
    const loaded = await loadPendingPrompts("srv1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].state).toBe("queued");
  });

  test("rejected state is preserved on load", async () => {
    await savePendingPrompt(
      makePrompt({ promptId: "rej-1", state: "rejected", error: "nope" }),
    );
    const loaded = await loadPendingPrompts("srv1");
    expect(loaded[0].state).toBe("rejected");
    expect(loaded[0].error).toBe("nope");
  });

  test("load sorts by createdAt", async () => {
    await savePendingPrompt(
      makePrompt({ promptId: "late", createdAt: "2025-01-02T00:00:00Z" }),
    );
    await savePendingPrompt(
      makePrompt({ promptId: "early", createdAt: "2025-01-01T00:00:00Z" }),
    );
    const loaded = await loadPendingPrompts("srv1");
    expect(loaded[0].promptId).toBe("early");
    expect(loaded[1].promptId).toBe("late");
  });

  test("toPlainPrompt strips Svelte proxies (images + newSession)", async () => {
    // Simulate a Svelte proxy: an object with a `get` trap that returns nested
    // proxies. The save function must deep-clone to plain data so IndexedDB's
    // structured clone doesn't throw DataCloneError.
    const proxyImages = [
      new Proxy(
        { type: "image" as const, data: "base64data", mimeType: "image/png" },
        {},
      ),
    ];
    const proxyNewSession = new Proxy(
      {
        cwd: "/tmp",
        worktree: true,
        baseBranch: "main",
        model: new Proxy({ modelId: "gpt-4" }, {}),
        thinking: "high",
      },
      {},
    );
    const prompt = makePrompt({
      promptId: "proxy-1",
      images: proxyImages as unknown as PendingPrompt["images"],
      newSession:
        proxyNewSession as unknown as PendingPrompt["newSession"],
    });
    // Must not throw DataCloneError.
    await savePendingPrompt(prompt);
    const loaded = await loadPendingPrompts("srv1");
    expect(loaded[0].images).toEqual([
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
    expect(loaded[0].newSession?.model?.modelId).toBe("gpt-4");
  });
});
