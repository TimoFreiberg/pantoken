import { describe, expect, test } from "bun:test";
import type { ModelDefaults } from "@pantoken/protocol";
import {
  auxClickAction,
  reseedDraftFromDefaults,
  type DraftConfig,
} from "./store-helpers.js";

function emptyDraft(cwd = "/proj"): DraftConfig {
  return { cwd, worktree: false };
}

const FULL_DEFAULTS: ModelDefaults = {
  provider: "umans/umans-glm-5.2",
  modelId: "umans/umans-glm-5.2",
  thinkingLevel: "high",
  favorites: [],
  defaultPermissionMonitor: "bypass_plus",
};

describe("auxClickAction", () => {
  test("maps browser back and forward buttons", () => {
    expect(auxClickAction(3)).toBe("back");
    expect(auxClickAction(4)).toBe("forward");
  });

  test("ignores other mouse buttons", () => {
    expect(auxClickAction(0)).toBeNull();
    expect(auxClickAction(1)).toBeNull();
    expect(auxClickAction(2)).toBeNull();
    expect(auxClickAction(5)).toBeNull();
  });
});

describe("reseedDraftFromDefaults", () => {
  test("seeds model + thinking when both are unset (boot-path timing gap)", () => {
    const draft = emptyDraft();
    const out = reseedDraftFromDefaults(draft, FULL_DEFAULTS);
    expect(out.model).toEqual({
      provider: "umans/umans-glm-5.2",
      modelId: "umans/umans-glm-5.2",
    });
    expect(out.thinking).toBe("high");
    expect(out.permissionMonitor).toBe("bypass_plus");
  });

  test("does not clobber an explicitly picked model", () => {
    const draft: DraftConfig = {
      ...emptyDraft(),
      model: { provider: "anthropic", modelId: "claude-sonnet-5" },
      thinking: "max",
    };
    const out = reseedDraftFromDefaults(draft, FULL_DEFAULTS);
    expect(out.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5" });
    expect(out.thinking).toBe("max");
  });

  test("does not clobber an explicitly picked permission monitor", () => {
    const draft: DraftConfig = { ...emptyDraft(), permissionMonitor: "autonomous" };
    const out = reseedDraftFromDefaults(draft, FULL_DEFAULTS);
    expect(out.permissionMonitor).toBe("autonomous");
  });

  test("seeds only the unset field when the other is already set", () => {
    const draft: DraftConfig = {
      ...emptyDraft(),
      model: { provider: "anthropic", modelId: "claude-sonnet-5" },
    };
    const out = reseedDraftFromDefaults(draft, FULL_DEFAULTS);
    expect(out.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5" });
    expect(out.thinking).toBe("high");
  });

  test("seeds thinking but not model when defaults lack provider/modelId", () => {
    const draft = emptyDraft();
    const out = reseedDraftFromDefaults(draft, {
      ...FULL_DEFAULTS,
      provider: undefined,
      modelId: undefined,
    });
    expect(out.model).toBeUndefined();
    expect(out.thinking).toBe("high");
  });

  test("seeds model but not thinking when defaults lack thinkingLevel", () => {
    const draft = emptyDraft();
    const out = reseedDraftFromDefaults(draft, {
      ...FULL_DEFAULTS,
      thinkingLevel: undefined,
    });
    expect(out.model).toEqual({
      provider: "umans/umans-glm-5.2",
      modelId: "umans/umans-glm-5.2",
    });
    expect(out.thinking).toBeUndefined();
  });

  test("returns the same reference when nothing changes", () => {
    const draft: DraftConfig = {
      ...emptyDraft(),
      model: { provider: "anthropic", modelId: "claude-sonnet-5" },
      thinking: "max",
      permissionMonitor: "autonomous",
    };
    const out = reseedDraftFromDefaults(draft, FULL_DEFAULTS);
    expect(out).toBe(draft);
  });

  test("returns a new reference when it re-seeds", () => {
    const draft = emptyDraft();
    const out = reseedDraftFromDefaults(draft, FULL_DEFAULTS);
    expect(out).not.toBe(draft);
  });

  test("no-op against empty defaults", () => {
    const draft = emptyDraft();
    const out = reseedDraftFromDefaults(draft, { favorites: [] });
    expect(out).toBe(draft);
    expect(out.model).toBeUndefined();
    expect(out.thinking).toBeUndefined();
  });
});
