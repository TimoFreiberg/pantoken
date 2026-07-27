import { afterEach, describe, expect, test } from "vitest";
import { loadDraftConfigMap } from "../store.svelte.js";
import {
  LEGACY_KEYS,
  loadNamespacedMap,
  namespacedKey,
  persistNamespacedMap,
} from "./persistence.js";

afterEach(() => {
  localStorage.clear();
});

describe("legacy draft config tolerance", () => {
  test("ignores removed worktree fields without throwing", () => {
    localStorage.setItem(
      "pantoken.draftConfig",
      JSON.stringify({ "n:/repo": { worktree: true, baseBranch: "main" } }),
    );
    const loaded = loadDraftConfigMap();
    expect(loaded["n:/repo"]).toBeUndefined();
  });
});

describe("namespacedKey", () => {
  test("produces pantoken.<serverId>.<baseKey>", () => {
    expect(namespacedKey("composerDrafts", "server-abc")).toBe(
      "pantoken.server-abc.composerDrafts",
    );
  });

  test("different serverIds produce different keys", () => {
    expect(namespacedKey("composerDrafts", "server-a")).not.toBe(
      namespacedKey("composerDrafts", "server-b"),
    );
  });
});

describe("loadNamespacedMap / persistNamespacedMap", () => {
  test("round-trips a map", () => {
    const map = { "s:session1": "hello world", "n:/home": "draft text" };
    persistNamespacedMap("composerDrafts", "server-1", map);
    expect(loadNamespacedMap("composerDrafts", "server-1")).toEqual(map);
  });

  test("returns empty object for missing key", () => {
    expect(loadNamespacedMap("composerDrafts", "no-such-server")).toEqual({});
  });

  test("returns empty object for corrupt JSON", () => {
    localStorage.setItem(
      namespacedKey("composerDrafts", "corrupt-server"),
      "{not json",
    );
    expect(loadNamespacedMap("composerDrafts", "corrupt-server")).toEqual({});
  });

  test("identical session ids on two servers do not collide", () => {
    const mapA = { "s:shared-session": "draft from server A" };
    const mapB = { "s:shared-session": "draft from server B" };

    persistNamespacedMap("composerDrafts", "server-A", mapA);
    persistNamespacedMap("composerDrafts", "server-B", mapB);

    expect(loadNamespacedMap("composerDrafts", "server-A")["s:shared-session"]).toBe(
      "draft from server A",
    );
    expect(loadNamespacedMap("composerDrafts", "server-B")["s:shared-session"]).toBe(
      "draft from server B",
    );
  });

  test("identical cwds on two servers do not collide", () => {
    const cwd = "/home/user/project";
    const mapA = { [`n:${cwd}`]: { model: "claude" } };
    const mapB = { [`n:${cwd}`]: { model: "gpt" } };

    persistNamespacedMap("draftConfig", "server-A", mapA);
    persistNamespacedMap("draftConfig", "server-B", mapB);

    expect(loadNamespacedMap("draftConfig", "server-A")[`n:${cwd}`]).toEqual({
      model: "claude",
    });
    expect(loadNamespacedMap("draftConfig", "server-B")[`n:${cwd}`]).toEqual({
      model: "gpt",
    });
  });

  test("LEGACY_KEYS has the expected unnamespaced key names", () => {
    expect(LEGACY_KEYS.composerDrafts).toBe("pantoken.composerDrafts");
    expect(LEGACY_KEYS.draftConfig).toBe("pantoken.draftConfig");
    expect(LEGACY_KEYS.promptHistory).toBe("pantoken.promptHistory");
    expect(LEGACY_KEYS.lastProjectCwd).toBe("pantoken.lastProjectCwd");
    expect(LEGACY_KEYS.scrollPositions).toBe("pantoken.scrollPositions");
  });
});
