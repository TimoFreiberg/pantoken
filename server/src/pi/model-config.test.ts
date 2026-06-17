import { describe, expect, test } from "bun:test";
import {
  apiKeySetupSupported,
  inferAuthSource,
  mergeFavoritePatterns,
  type ModelLike,
  patternMatchesModel,
  resolveFavorites,
} from "./model-config.js";

const AVAILABLE: ModelLike[] = [
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "anthropic", id: "claude-sonnet-4-6" },
  { provider: "openai", id: "gpt-5" },
];

describe("apiKeySetupSupported", () => {
  test("curated providers are key-capable, others aren't", () => {
    expect(apiKeySetupSupported("openai")).toBe(true);
    expect(apiKeySetupSupported("google")).toBe(true);
    expect(apiKeySetupSupported("anthropic")).toBe(false); // OAuth-first, not in the set
    expect(apiKeySetupSupported("made-up")).toBe(false);
  });
});

describe("inferAuthSource", () => {
  test("explicit credential type wins", () => {
    expect(
      inferAuthSource({ type: "oauth" }, { configured: true }, false),
    ).toBe("oauth");
    expect(
      inferAuthSource({ type: "api_key" }, { configured: true }, true),
    ).toBe("auth_file");
  });
  test("falls back to the registry's auth-status source", () => {
    expect(
      inferAuthSource(undefined, { configured: true, source: "stored" }, true),
    ).toBe("auth_file");
    expect(
      inferAuthSource(
        undefined,
        { configured: true, source: "environment" },
        true,
      ),
    ).toBe("env");
    expect(
      inferAuthSource(
        undefined,
        { configured: true, source: "models_json_key" },
        true,
      ),
    ).toBe("external");
  });
  test("unconfigured is none; configured-but-sourceless splits on key support", () => {
    expect(inferAuthSource(undefined, { configured: false }, true)).toBe(
      "none",
    );
    expect(inferAuthSource(undefined, { configured: true }, true)).toBe("env");
    expect(inferAuthSource(undefined, { configured: true }, false)).toBe(
      "external",
    );
  });
});

describe("patternMatchesModel", () => {
  test("matches the forms pilot writes + common CLI forms", () => {
    expect(patternMatchesModel("openai/gpt-5", "openai", "gpt-5")).toBe(true);
    expect(patternMatchesModel("openai:gpt-5", "openai", "gpt-5")).toBe(true);
    expect(patternMatchesModel("gpt-5", "openai", "gpt-5")).toBe(true);
    expect(
      patternMatchesModel("anthropic/*", "anthropic", "claude-opus-4-8"),
    ).toBe(true);
  });
  test("does NOT fuzzy/substring match (strict by design)", () => {
    expect(patternMatchesModel("gpt", "openai", "gpt-5")).toBe(false);
    expect(
      patternMatchesModel("openai/*", "anthropic", "claude-opus-4-8"),
    ).toBe(false);
    expect(patternMatchesModel("", "openai", "gpt-5")).toBe(false);
  });
});

describe("resolveFavorites", () => {
  test("resolves patterns to available provider:modelId refs", () => {
    expect(resolveFavorites(["openai/gpt-5"], AVAILABLE)).toEqual([
      "openai:gpt-5",
    ]);
    expect(resolveFavorites(["anthropic/*"], AVAILABLE)).toEqual([
      "anthropic:claude-opus-4-8",
      "anthropic:claude-sonnet-4-6",
    ]);
  });
  test("empty / undefined patterns resolve to no favorites", () => {
    expect(resolveFavorites(undefined, AVAILABLE)).toEqual([]);
    expect(resolveFavorites([], AVAILABLE)).toEqual([]);
  });
  test("patterns that match nothing available drop out", () => {
    expect(resolveFavorites(["mistral/foo"], AVAILABLE)).toEqual([]);
  });
});

describe("mergeFavoritePatterns", () => {
  test("stores selected refs as pi's provider/modelId form", () => {
    expect(
      mergeFavoritePatterns(undefined, ["openai:gpt-5"], AVAILABLE),
    ).toEqual(["openai/gpt-5"]);
  });
  test("preserves patterns that don't resolve to any available model", () => {
    // `mistral/*` is offline (no available mistral models) → kept; the resolvable
    // `anthropic/*` is replaced by the explicit selection.
    const next = mergeFavoritePatterns(
      ["mistral/*", "anthropic/*"],
      ["anthropic:claude-opus-4-8"],
      AVAILABLE,
    );
    expect(next).toContain("mistral/*");
    expect(next).toContain("anthropic/claude-opus-4-8");
    expect(next).not.toContain("anthropic/claude-sonnet-4-6");
  });
  test("dedupes and returns undefined for an empty result (clears the filter)", () => {
    expect(
      mergeFavoritePatterns(["openai/gpt-5"], ["openai:gpt-5"], AVAILABLE),
    ).toEqual(["openai/gpt-5"]);
    expect(mergeFavoritePatterns([], [], AVAILABLE)).toBeUndefined();
  });
});
