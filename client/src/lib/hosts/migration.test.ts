import { afterEach, describe, expect, test } from "bun:test";
import { migrateLegacyPersistence } from "./migration.js";
import {
  LEGACY_KEYS,
  loadNamespacedMap,
  namespacedKey,
} from "./persistence.js";

afterEach(() => {
  localStorage.clear();
});

describe("migrateLegacyPersistence", () => {
  test("legacy unnamespaced drafts migrate to the initial local server without data loss", () => {
    const drafts = { "s:session1": "hello world" };
    localStorage.setItem(
      LEGACY_KEYS.composerDrafts,
      JSON.stringify(drafts),
    );

    const migrated = migrateLegacyPersistence("server-initial");
    expect(migrated).toBe(true);

    const loaded = loadNamespacedMap<string>(
      "composerDrafts",
      "server-initial",
    );
    expect(loaded).toEqual(drafts);
  });

  test("migration is idempotent (second call is a no-op)", () => {
    const drafts = { "s:session1": "hello world" };
    localStorage.setItem(
      LEGACY_KEYS.composerDrafts,
      JSON.stringify(drafts),
    );

    migrateLegacyPersistence("server-initial");
    // Second call should NOT report migration.
    const migrated = migrateLegacyPersistence("server-initial");
    expect(migrated).toBe(false);
  });

  test("migration does not overwrite existing namespaced data", () => {
    // Set up legacy data.
    const legacyDrafts = { "s:old": "legacy draft" };
    localStorage.setItem(
      LEGACY_KEYS.composerDrafts,
      JSON.stringify(legacyDrafts),
    );

    // Set up namespaced data that already exists.
    const namespacedDrafts = { "s:new": "namespaced draft" };
    localStorage.setItem(
      namespacedKey("composerDrafts", "server-initial"),
      JSON.stringify(namespacedDrafts),
    );

    migrateLegacyPersistence("server-initial");

    // The namespaced data should be untouched.
    const loaded = loadNamespacedMap<string>(
      "composerDrafts",
      "server-initial",
    );
    expect(loaded).toEqual(namespacedDrafts);
    expect(loaded["s:old"]).toBeUndefined();
  });

  test("migration never deletes old global keys", () => {
    const drafts = { "s:session1": "hello world" };
    localStorage.setItem(
      LEGACY_KEYS.composerDrafts,
      JSON.stringify(drafts),
    );

    migrateLegacyPersistence("server-initial");

    // The old global key should still be present.
    expect(localStorage.getItem(LEGACY_KEYS.composerDrafts)).not.toBeNull();
  });

  test("migration returns false when no legacy data exists", () => {
    const migrated = migrateLegacyPersistence("server-initial");
    expect(migrated).toBe(false);
  });

  test("migrates all five legacy keys", () => {
    localStorage.setItem(
      LEGACY_KEYS.composerDrafts,
      JSON.stringify({ "s:1": "draft" }),
    );
    localStorage.setItem(
      LEGACY_KEYS.draftConfig,
      JSON.stringify({ "n:/home": { worktree: true } }),
    );
    localStorage.setItem(
      LEGACY_KEYS.promptHistory,
      JSON.stringify({ "s:1": ["prompt"] }),
    );
    localStorage.setItem(LEGACY_KEYS.lastProjectCwd, "/home/user");
    localStorage.setItem(
      LEGACY_KEYS.scrollPositions,
      JSON.stringify({ "s:1": { ratio: 0.5 } }),
    );

    const migrated = migrateLegacyPersistence("server-initial");
    expect(migrated).toBe(true);

    // All five should be present in namespaced storage.
    expect(
      localStorage.getItem(namespacedKey("composerDrafts", "server-initial")),
    ).not.toBeNull();
    expect(
      localStorage.getItem(namespacedKey("draftConfig", "server-initial")),
    ).not.toBeNull();
    expect(
      localStorage.getItem(namespacedKey("promptHistory", "server-initial")),
    ).not.toBeNull();
    expect(
      localStorage.getItem(namespacedKey("lastProjectCwd", "server-initial")),
    ).toBe("/home/user");
    expect(
      localStorage.getItem(
        namespacedKey("scrollPositions", "server-initial"),
      ),
    ).not.toBeNull();
  });
});
