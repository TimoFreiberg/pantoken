import { describe, expect, test } from "vitest";
import type { FileInfo, ModelOption } from "@pantoken/protocol";
import {
  buildAtItems,
  classifyAtQuery,
  extractAtQuery,
  filterFiles,
  filterModels,
  filterNames,
  splitExternalQuery,
  stepLevel,
  type AtItem,
  type BuildAtItemsParams,
} from "./file-autocomplete.js";

describe("extractAtQuery", () => {
  test("returns the text after @ at cursor position", () => {
    const r = extractAtQuery("hello @file.ts", 14);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("file.ts");
    expect(r!.atPos).toBe(6);
  });

  test("empty query when @ is just typed", () => {
    const r = extractAtQuery("@", 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("");
    expect(r!.atPos).toBe(0);
  });

  test("returns null when there is no @", () => {
    expect(extractAtQuery("hello world", 5)).toBeNull();
  });

  test("returns null for email-like @ (embedded in a word)", () => {
    expect(extractAtQuery("email@domain.com", 13)).toBeNull();
  });

  test("@ at a token boundary (after space) is valid", () => {
    const r = extractAtQuery("review @src/foo", 15);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("src/foo");
    expect(r!.atPos).toBe(7);
  });

  test("@ after comma is a token boundary", () => {
    const r = extractAtQuery("check,@test", 11);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("test");
  });

  test("returns only the active token, not a later @", () => {
    // "@one some @two" with cursor right after "@one" (pos 4, before the space)
    // → query is just "one"; the later @two is irrelevant.
    const r = extractAtQuery("@one some @two", 4);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("one");
    expect(r!.atPos).toBe(0);
  });

  test("whitespace inside the token closes the mention", () => {
    // Cursor past a space after the mention ("@one some|") — the mention ended
    // at the space, so this is plain prose, not an active mention. Guards the
    // runaway-fd bug: without this, every word typed after a mention re-queries.
    expect(extractAtQuery("@one some", 9)).toBeNull();
    expect(extractAtQuery("@README.md explain", 18)).toBeNull();
  });

  test("cursor before the @ returns null", () => {
    expect(extractAtQuery("before @after", 3)).toBeNull();
  });

  test("whitespace after @ closes the token (not a mention)", () => {
    expect(extractAtQuery("@ ", 2)).toBeNull();
    expect(extractAtQuery("@\t", 2)).toBeNull();
  });

  test("slash mode at position 0 suppresses @ at the start", () => {
    // "/@foo" with cursor at 5 — slash takes priority
    expect(extractAtQuery("/@foo", 5)).toBeNull();
  });

  test("@ after slash-command arg is valid", () => {
    // "/review @src" with cursor at 13 — slash settled, @ is file mention
    const r = extractAtQuery("/review @src", 13);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("src");
    expect(r!.atPos).toBe(8);
  });

  test("cursor at the exact @ position returns empty query", () => {
    const r = extractAtQuery("@", 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("");
  });

  test("partial typing after @ works", () => {
    const r = extractAtQuery("check @serv", 11);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("serv");
    expect(r!.atPos).toBe(6);
  });

  test("empty draft returns null", () => {
    expect(extractAtQuery("", 0)).toBeNull();
  });

  test("cursor clamped to draft length", () => {
    const r = extractAtQuery("@file", 999);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("file");
  });
});

describe("filterFiles", () => {
  const f = (path: string, isDirectory = false): FileInfo => ({
    path,
    isDirectory,
  });
  const FILES: readonly FileInfo[] = [
    f("README.md"),
    f("store", true),
    f("store.ts"),
    f("lib/mystore.ts"),
    f("server", true),
    f("server/src/hub.ts"),
    f("docs/DESIGN.md"),
  ];
  const paths = (items: FileInfo[]) => items.map((i) => i.path);

  test("empty query returns the head of the index (bare @)", () => {
    expect(paths(filterFiles(FILES, "", 3))).toEqual([
      "README.md",
      "store",
      "store.ts",
    ]);
  });

  test("substring match drops non-matches", () => {
    // "hub" is a subsequence of "server/src/hub.ts" only.
    expect(paths(filterFiles(FILES, "hub"))).toEqual(["server/src/hub.ts"]);
  });

  test("match is case-insensitive", () => {
    expect(paths(filterFiles(FILES, "HUB"))).toEqual(["server/src/hub.ts"]);
  });

  test("ranks path-prefix > basename-prefix > interior (fuzzy)", () => {
    // "store": path-prefix (store, store.ts) before interior (lib/mystore.ts).
    // store and store.ts are both tier 0 (path starts with "store"); alphabetical
    // puts the shorter "store" first. lib/mystore.ts is tier 4 (fuzzy interior).
    expect(paths(filterFiles(FILES, "store"))).toEqual([
      "store", // path-prefix, alphabetical first
      "store.ts", // path-prefix, alphabetical second
      "lib/mystore.ts", // fuzzy interior match → last
    ]);
  });

  test("path-prefix outranks an interior match", () => {
    const files = [f("lib/observer.ts"), f("server/src/hub.ts")];
    // "server": path-prefix on the second; fuzzy interior (inside "observer") on the first.
    expect(paths(filterFiles(files, "server"))).toEqual([
      "server/src/hub.ts",
      "lib/observer.ts",
    ]);
  });

  test("respects the limit", () => {
    expect(filterFiles(FILES, "", 2)).toHaveLength(2);
    const manyTs = [f("a.ts"), f("b.ts"), f("c.ts"), f("d.ts")];
    expect(filterFiles(manyTs, ".ts", 2)).toHaveLength(2);
  });

  test("no match returns empty", () => {
    expect(filterFiles(FILES, "zzz")).toEqual([]);
  });

  // ── Edge-case fixtures from the at-mention fixture comparison (issue #63) ──
  // These encode the agreed behavior (mimic polytoken's TUI) as a regression
  // guard. Each row mirrors a file structure from parity/fixtures/at-mention-fixture/
  // and asserts the exact ranked order observed in the polytoken TUI. One row per
  // (files, query) → expected assertion: the multi-query fixtures above are
  // flattened so every assertion survives as a named case in the table.

  type FilterCase = {
    name: string;
    files: readonly FileInfo[];
    query: string;
    expected: string[];
  };
  const filterCases: readonly FilterCase[] = [
    {
      // Case-insensitive: lowercase, mixed, and ALL CAPS all match the same order.
      name: "case sensitivity — lowercase",
      files: [
        f("server.rs"),
        f("caps/Server.rs"),
        f("docs/server-selection-rest-api.md"),
        f("src/server/", true),
        f("src/server/lookup.rs"),
      ],
      query: "server",
      expected: [
        "server.rs",
        "caps/Server.rs",
        "docs/server-selection-rest-api.md",
        "src/server/",
        "src/server/lookup.rs",
      ],
    },
    {
      name: "case sensitivity — mixed case",
      files: [
        f("server.rs"),
        f("caps/Server.rs"),
        f("docs/server-selection-rest-api.md"),
        f("src/server/", true),
        f("src/server/lookup.rs"),
      ],
      query: "Server",
      expected: [
        "server.rs",
        "caps/Server.rs",
        "docs/server-selection-rest-api.md",
        "src/server/",
        "src/server/lookup.rs",
      ],
    },
    {
      name: "case sensitivity — ALL CAPS",
      files: [
        f("server.rs"),
        f("caps/Server.rs"),
        f("docs/server-selection-rest-api.md"),
        f("src/server/", true),
        f("src/server/lookup.rs"),
      ],
      query: "SERVER",
      expected: [
        "server.rs",
        "caps/Server.rs",
        "docs/server-selection-rest-api.md",
        "src/server/",
        "src/server/lookup.rs",
      ],
    },
    {
      // server.rs path-prefix (tier 0); caps/Server.rs, docs/server-selection…,
      // src/server/ basename-prefix (tier 1); src/server/lookup.rs segment-prefix
      // (tier 2). Tier order determines ranking; alphabetical within a tier.
      name: "cross-dir deranking — basename-prefix outranks segment-prefix",
      files: [
        f("src/server/lookup.rs"),
        f("src/server/", true),
        f("docs/server-selection-rest-api.md"),
        f("caps/Server.rs"),
        f("server.rs"),
      ],
      query: "server",
      expected: [
        "server.rs",
        "caps/Server.rs",
        "docs/server-selection-rest-api.md",
        "src/server/",
        "src/server/lookup.rs",
      ],
    },
    {
      // test-utils.ts path-prefix (tier 0); utils-test.ts word-boundary (tier 3,
      // "test" after "-"); docs/server-selection-rest-api.md fuzzy (tier 4).
      name: "suffix matching — suffix matches via fuzzy subsequence",
      files: [
        f("docs/server-selection-rest-api.md"),
        f("utils-test.ts"),
        f("test-utils.ts"),
      ],
      query: "test",
      expected: [
        "test-utils.ts",
        "utils-test.ts",
        "docs/server-selection-rest-api.md",
      ],
    },
    {
      // srselrs → fuzzy subsequence of src/selection.rs (s,r,c,/,s,e,l,…,r,s).
      // Also matches src/server/lookup.rs and docs/server-selection-rest-api.md.
      name: "typo leniency — srselrs matches scrambled src/selection.rs",
      files: [
        f("src/selection.rs"),
        f("src/server/lookup.rs"),
        f("docs/server-selection-rest-api.md"),
        f("config.ts"),
      ],
      query: "srselrs",
      expected: [
        "src/selection.rs",
        "src/server/lookup.rs",
        "docs/server-selection-rest-api.md",
      ],
    },
    {
      // servre → transposition of "server": matches docs/server-selection-rest-api.md.
      name: "typo leniency — servre matches server-selection-rest-api",
      files: [
        f("src/selection.rs"),
        f("src/server/lookup.rs"),
        f("docs/server-selection-rest-api.md"),
        f("config.ts"),
      ],
      query: "servre",
      expected: ["docs/server-selection-rest-api.md"],
    },
    {
      // conifg → c-o-n-i-f-g: "config" is c-o-n-f-i-g (f before i), so no
      // subsequence match — nothing matches.
      name: "typo leniency — conifg matches nothing",
      files: [
        f("src/selection.rs"),
        f("src/server/lookup.rs"),
        f("docs/server-selection-rest-api.md"),
        f("config.ts"),
      ],
      query: "conifg",
      expected: [],
    },
    {
      // No dir-before-file preference within a tier: alphabetical by path only.
      // index/ and index/deep.ts both tier 0 ("index/" sorts first as shorter);
      // client/index.ts and src/index.ts both tier 1, "client" < "src".
      name: "dir-before-file tiebreaker — alphabetical within same tier",
      files: [
        f("src/index.ts"),
        f("client/index.ts"),
        f("index/deep.ts"),
        f("index/", true),
      ],
      query: "index",
      expected: [
        "index/",
        "index/deep.ts",
        "client/index.ts",
        "src/index.ts",
      ],
    },
    {
      // Trailing slash → directory drill-down: the dir + its immediate children.
      name: "trailing slash — directory drill-down shows dir + children",
      files: [
        f("index/", true),
        f("index/deep.ts"),
        f("index/deep/nested.ts"),
        f("client/index.ts"),
      ],
      query: "index/",
      expected: ["index/", "index/deep.ts"],
    },
    {
      // ".env" matches .env (path-prefix) only — .eslintrc.json has no 'v'.
      name: "dotfile handling — .env matches .env only",
      files: [f(".env"), f(".eslintrc.json"), f("config.ts")],
      query: ".env",
      expected: [".env"],
    },
    {
      // ".esl" matches .eslintrc.json (path-prefix) only.
      name: "dotfile handling — .esl matches .eslintrc.json only",
      files: [f(".env"), f(".eslintrc.json"), f("config.ts")],
      query: ".esl",
      expected: [".eslintrc.json"],
    },
    {
      name: "gitignored files — bundle matches dist/bundle.js",
      files: [f("dist/bundle.js"), f("server.log"), f("server.rs")],
      query: "bundle",
      expected: ["dist/bundle.js"],
    },
    {
      // Both server.log and server.rs are tier 0 (path-prefix); alphabetical
      // puts "server.log" < "server.rs".
      name: "gitignored files — server matches log then rs alphabetically",
      files: [f("dist/bundle.js"), f("server.log"), f("server.rs")],
      query: "server",
      expected: ["server.log", "server.rs"],
    },
  ];
  for (const { name, files, query, expected } of filterCases) {
    test(`fixture: ${name}`, () => {
      expect(paths(filterFiles(files, query))).toEqual(expected);
    });
  }
});

describe("classifyAtQuery", () => {
  test("skill: long form", () => {
    expect(classifyAtQuery("skill:debug")).toEqual({
      mode: "skill",
      partial: "debug",
    });
  });

  test("s: shorthand", () => {
    expect(classifyAtQuery("s:debug")).toEqual({
      mode: "skill",
      partial: "debug",
    });
  });

  test("subagent: long form", () => {
    expect(classifyAtQuery("subagent:reviewer")).toEqual({
      mode: "subagent",
      partial: "reviewer",
    });
  });

  test("a: shorthand", () => {
    expect(classifyAtQuery("a:reviewer")).toEqual({
      mode: "subagent",
      partial: "reviewer",
    });
  });

  test("model: long form", () => {
    expect(classifyAtQuery("model:anthropic/claude-opus-4-8")).toEqual({
      mode: "model",
      partial: "anthropic/claude-opus-4-8",
    });
  });

  test("m: shorthand", () => {
    expect(classifyAtQuery("m:sonnet")).toEqual({
      mode: "model",
      partial: "sonnet",
    });
  });

  test("external: leading slash", () => {
    expect(classifyAtQuery("/etc/hosts")).toEqual({
      mode: "external",
      raw: "/etc/hosts",
    });
  });

  test("external: leading tilde", () => {
    expect(classifyAtQuery("~/Documents")).toEqual({
      mode: "external",
      raw: "~/Documents",
    });
  });

  test("external: leading ..", () => {
    expect(classifyAtQuery("../sibling/file.ts")).toEqual({
      mode: "external",
      raw: "../sibling/file.ts",
    });
  });

  test("bare shorthand letters without a colon are project queries", () => {
    expect(classifyAtQuery("s")).toEqual({ mode: "project", partial: "s" });
    expect(classifyAtQuery("a")).toEqual({ mode: "project", partial: "a" });
    expect(classifyAtQuery("m")).toEqual({ mode: "project", partial: "m" });
  });

  test("sigils are case-sensitive lowercase — mixed case falls through to project", () => {
    expect(classifyAtQuery("Skill:debug")).toEqual({
      mode: "project",
      partial: "Skill:debug",
    });
    expect(classifyAtQuery("S:debug")).toEqual({
      mode: "project",
      partial: "S:debug",
    });
  });

  test("an ordinary path is a project query", () => {
    expect(classifyAtQuery("src/foo.ts")).toEqual({
      mode: "project",
      partial: "src/foo.ts",
    });
  });

  test("empty query is a project query with an empty partial", () => {
    expect(classifyAtQuery("")).toEqual({ mode: "project", partial: "" });
  });
});

describe("filterNames", () => {
  const NAMES = ["debug", "journal", "reviewer", "explorer"];

  test("empty partial returns the head of the list as-given", () => {
    expect(filterNames(NAMES, "", 2)).toEqual(["debug", "journal"]);
  });

  test("case-insensitive substring match", () => {
    expect(filterNames(NAMES, "REV")).toEqual(["reviewer"]);
  });

  test("case-insensitive fuzzy subsequence match", () => {
    expect(filterNames(["jj-workspaces", "journal"], "JW")).toEqual([
      "jj-workspaces",
    ]);
  });

  test("contiguous matches rank before fuzzy-only matches", () => {
    expect(filterNames(["a-b-c-fuzzy", "xabc-interior"], "abc")).toEqual([
      "xabc-interior",
      "a-b-c-fuzzy",
    ]);
  });

  test("exact and name-prefix matches share the first alphabetical tier", () => {
    expect(filterNames(["debugger", "debug", "debug-tools"], "debug")).toEqual([
      "debug",
      "debug-tools",
      "debugger",
    ]);
  });

  test("name-start match ranks before an interior match", () => {
    // "explorer" starts with "exp"; "reviewer" doesn't contain it at all — pick a
    // query that's an interior match for one name and a start match for another.
    expect(filterNames(["subreview", "reviewer"], "review")).toEqual([
      "reviewer", // start-of-name match
      "subreview", // interior match
    ]);
  });

  test("ties break alphabetically", () => {
    expect(filterNames(["zeta", "alpha"], "a")).toEqual(["alpha", "zeta"]);
  });

  test("respects the limit", () => {
    const many = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
    expect(filterNames(many, "x", 5)).toEqual(["x1", "x2", "x3", "x4", "x5"]);
  });

  test("caps fuzzy-only matches after ranking", () => {
    const many = ["s-a-5", "s-a-2", "s-a-4", "s-a-1", "s-a-3", "s-a-6"];
    expect(filterNames(many, "sa", 3)).toEqual(["s-a-1", "s-a-2", "s-a-3"]);
  });

  test("no match returns empty", () => {
    expect(filterNames(NAMES, "zzz")).toEqual([]);
  });
});

describe("filterModels", () => {
  const m = (modelId: string, label: string): ModelOption => ({ modelId, label });
  const MODELS: readonly ModelOption[] = [
    m("anthropic/claude-opus-4-8", "Claude Opus 4.8"),
    m("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"),
    m("openai/gpt-5", "GPT-5"),
  ];
  const ids = (items: ModelOption[]) => items.map((i) => i.modelId);

  test("empty partial returns the head of the list as-given", () => {
    expect(ids(filterModels(MODELS, "", 2))).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  test("matches modelId", () => {
    expect(ids(filterModels(MODELS, "gpt"))).toEqual(["openai/gpt-5"]);
  });

  test("matches label (case-insensitive)", () => {
    expect(ids(filterModels([MODELS[0]!], "opus"))).toEqual([
      "anthropic/claude-opus-4-8",
    ]);
  });

  test("matches full-registry modelId substring", () => {
    expect(ids(filterModels(MODELS, "anthropic/claude-sonnet"))).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  test("matches a mixed-case fuzzy subsequence in the modelId", () => {
    expect(ids(filterModels([m("Acme/Orion-5", "Orion")], "aO5"))).toEqual([
      "Acme/Orion-5",
    ]);
  });

  test("matches a mixed-case fuzzy subsequence in the label", () => {
    expect(ids(filterModels([m("acme/model", "Open Interface 5")], "oI5"))).toEqual([
      "acme/model",
    ]);
  });

  test("contiguous matches rank before fuzzy-only matches", () => {
    const models = [
      m("z/m-x-o-d", "Fuzzy"),
      m("z/interior-model", "Model Interior"),
    ];
    expect(ids(filterModels(models, "mod"))).toEqual([
      "z/interior-model",
      "z/m-x-o-d",
    ]);
  });

  test("label-prefix does not outrank a modelId interior substring", () => {
    const models = [
      m("z/label-match", "Model Prefix"),
      m("a/interior-model", "Unrelated"),
    ];
    expect(ids(filterModels(models, "model"))).toEqual([
      "a/interior-model",
      "z/label-match",
    ]);
  });

  test("fuzzy ties are deterministic by modelId", () => {
    const models = [
      m("z/a-x-b", "Unrelated"),
      m("a/a-y-b", "Unrelated"),
    ];
    expect(ids(filterModels(models, "ab"))).toEqual(["a/a-y-b", "z/a-x-b"]);
  });

  test("modelId-prefix matches rank before contiguous interior matches", () => {
    const models = [
      m("model-prefix", "Prefix"),
      m("x/model-interior", "Interior"),
    ];
    expect(ids(filterModels(models, "model"))).toEqual([
      "model-prefix",
      "x/model-interior",
    ]);
  });

  test("ranks a modelId-start match before an interior/label-only match", () => {
    const models = [
      m("x/gpt-5", "GPT-5"), // label contains "5", modelId starts with "x/gpt", not "5"
      m("x/5-flash", "Five Flash"), // modelId starts with "x/5"
    ];
    expect(ids(filterModels(models, "5"))).toEqual(["x/5-flash", "x/gpt-5"]);
  });

  test("respects the limit", () => {
    expect(filterModels(MODELS, "", 1)).toHaveLength(1);
  });

  test("caps fuzzy-only matches after ranking", () => {
    const many = [
      m("x/s-a-5", "Unrelated"),
      m("x/s-a-2", "Unrelated"),
      m("x/s-a-4", "Unrelated"),
      m("x/s-a-1", "Unrelated"),
    ];
    expect(ids(filterModels(many, "sa", 2))).toEqual(["x/s-a-1", "x/s-a-2"]);
  });

  test("no match returns empty", () => {
    expect(filterModels(MODELS, "zzz")).toEqual([]);
  });
});

describe("stepLevel", () => {
  const LEVELS = ["off", "low", "medium", "high"] as const;

  test("undefined levels always yield null", () => {
    expect(stepLevel(undefined, null, 1)).toBeNull();
    expect(stepLevel(undefined, "high", -1)).toBeNull();
  });

  test("empty levels always yield null", () => {
    expect(stepLevel([], null, 1)).toBeNull();
    expect(stepLevel([], "high", -1)).toBeNull();
  });

  test("] steps null to the first level, then onward", () => {
    let level = stepLevel(LEVELS, null, 1);
    expect(level).toBe("off");
    level = stepLevel(LEVELS, level, 1);
    expect(level).toBe("low");
    level = stepLevel(LEVELS, level, 1);
    expect(level).toBe("medium");
  });

  test("] clamps at the top level instead of wrapping to null", () => {
    expect(stepLevel(LEVELS, "high", 1)).toBe("high");
  });

  test("[ steps down through the levels", () => {
    expect(stepLevel(LEVELS, "high", -1)).toBe("medium");
    expect(stepLevel(LEVELS, "medium", -1)).toBe("low");
  });

  test("[ steps past the first level back to null", () => {
    expect(stepLevel(LEVELS, "off", -1)).toBeNull();
  });

  test("[ on null stays null (already at the floor)", () => {
    expect(stepLevel(LEVELS, null, -1)).toBeNull();
  });

  test("a single-level list clamps immediately", () => {
    expect(stepLevel(["off"], null, 1)).toBe("off");
    expect(stepLevel(["off"], "off", 1)).toBe("off");
    expect(stepLevel(["off"], "off", -1)).toBeNull();
  });

  test("a stale current not present in levels is treated as null", () => {
    expect(stepLevel(LEVELS, "extreme", 1)).toBe("off");
    expect(stepLevel(LEVELS, "extreme", -1)).toBeNull();
  });
});

describe("buildAtItems", () => {
  const f = (path: string, isDirectory = false): FileInfo => ({
    path,
    isDirectory,
  });
  const m = (modelId: string, label: string): ModelOption => ({ modelId, label });

  const SKILLS = ["debug", "journal"];
  const SUBAGENTS = ["reviewer", "explorer"];
  const MODELS: readonly ModelOption[] = [
    m("anthropic/claude-opus-4-8", "Claude Opus 4.8"),
    m("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"),
    m("openai/gpt-5", "GPT-5"),
  ];
  const FILES: readonly FileInfo[] = [
    f("README.md"),
    f("store", true),
    f("store.ts"),
  ];

  const base = {
    files: FILES,
    serverFiles: [] as readonly FileInfo[],
    skills: SKILLS,
    subagents: SUBAGENTS,
    models: MODELS,
  };

  // Each row is one (params → expected) assertion. The multi-query tests below
  // are flattened so every assertion survives as a named case in the table.
  // `base` is spread for the common case; rows that deviate pass their own params.
  type BuildCase = {
    name: string;
    params: BuildAtItemsParams;
    expected?: AtItem[];
    expectedLength?: number;
  };
  const buildCases: readonly BuildCase[] = [
    {
      // skill: full takeover — only skill items, filtered to the partial.
      name: "skill mode is a full takeover — only skill items, filtered",
      params: { ...base, query: "skill:jo" },
      expected: [{ kind: "skill", name: "journal" }],
    },
    {
      name: "skill shorthand uses fuzzy matching",
      params: { ...base, query: "s:jw", skills: ["jj-workspaces"] },
      expected: [{ kind: "skill", name: "jj-workspaces" }],
    },
    {
      name: "skill long alias uses fuzzy matching",
      params: { ...base, query: "skill:jw", skills: ["jj-workspaces"] },
      expected: [{ kind: "skill", name: "jj-workspaces" }],
    },
    {
      name: "subagent mode via shorthand is a full takeover",
      params: { ...base, query: "a:rev" },
      expected: [{ kind: "subagent", name: "reviewer" }],
    },
    {
      name: "long subagent mode uses fuzzy matching",
      params: { ...base, query: "subagent:RvR", subagents: ["reviewer"] },
      expected: [{ kind: "subagent", name: "reviewer" }],
    },
    {
      name: "subagent shorthand uses fuzzy matching",
      params: { ...base, query: "a:RvR", subagents: ["reviewer"] },
      expected: [{ kind: "subagent", name: "reviewer" }],
    },
    {
      name: "model mode is a full takeover",
      params: { ...base, query: "m:sonnet" },
      expected: [{ kind: "model", model: MODELS[1]! }],
    },
    {
      name: "model shorthand uses fuzzy matching",
      params: { ...base, query: "m:OI5", models: [m("openai/gpt-5", "GPT-5")] },
      expected: [{ kind: "model", model: m("openai/gpt-5", "GPT-5") }],
    },
    {
      name: "model long alias uses fuzzy matching",
      params: { ...base, query: "model:OI5", models: [m("openai/gpt-5", "GPT-5")] },
      expected: [{ kind: "model", model: m("openai/gpt-5", "GPT-5") }],
    },
    {
      name: "bare project query caps fuzzy badges and keeps sigils last",
      params: {
        ...base,
        query: "sk",
        files: [f("sk-file.txt")],
        skills: ["s-a-k-1", "s-a-k-2", "s-a-k-3", "s-a-k-4", "s-a-k-5", "s-a-k-6"],
        subagents: ["s-b-k-1", "s-b-k-2", "s-b-k-3", "s-b-k-4", "s-b-k-5", "s-b-k-6"],
        models: [
          m("x/s-c-k-1", "Unrelated"),
          m("x/s-c-k-2", "Unrelated"),
          m("x/s-c-k-3", "Unrelated"),
          m("x/s-c-k-4", "Unrelated"),
          m("x/s-c-k-5", "Unrelated"),
          m("x/s-c-k-6", "Unrelated"),
        ],
      },
      expected: [
        { kind: "file", file: f("sk-file.txt") },
        ...[1, 2, 3, 4, 5].map((n) => ({ kind: "skill", name: `s-a-k-${n}` as string })),
        ...[1, 2, 3, 4, 5].map((n) => ({ kind: "subagent", name: `s-b-k-${n}` as string })),
        ...[1, 2, 3, 4, 5].map((n) => ({ kind: "model", model: m(`x/s-c-k-${n}`, "Unrelated") })),
        { kind: "sigil", prefix: "skill:", label: "browse skills…" },
      ],
    },
    {
      name: "takeover mode with an empty partial returns the whole kind list",
      params: { ...base, query: "skill:" },
      expected: [
        { kind: "skill", name: "debug" },
        { kind: "skill", name: "journal" },
      ],
    },
    {
      // External mode never falls back to the local index — three lead-ins.
      name: "external mode — ~/Documents with no server results: empty",
      params: { ...base, query: "~/Documents" },
      expected: [],
    },
    {
      name: "external mode — /etc/hosts with no server results: empty",
      params: { ...base, query: "/etc/hosts" },
      expected: [],
    },
    {
      name: "external mode — ../sibling with no server results: empty",
      params: { ...base, query: "../sibling" },
      expected: [],
    },
    {
      // Server-resolved external files map straight to file rows — no badges, no sigils.
      name: "external mode maps server-resolved files straight to file rows",
      params: {
        ...base,
        query: "~/",
        serverFiles: [f("~/notes.md"), f("~/projects", true)],
      },
      expected: [
        { kind: "file", file: f("~/notes.md") },
        { kind: "file", file: f("~/projects", true) },
      ],
    },
    {
      // The local project index is deliberately irrelevant in external mode —
      // "~/README" must never surface the local "README.md".
      name: "external mode ignores the local file index even when it would match",
      params: {
        ...base,
        query: "~/README",
        serverFiles: [f("~/README.md")],
      },
      expected: [{ kind: "file", file: f("~/README.md") }],
    },
    {
      name: "external mode caps results at `limit`",
      params: {
        ...base,
        query: "~/",
        serverFiles: Array.from({ length: 5 }, (_, i) => f(`~/file${i}.txt`)),
        limit: 3,
      },
      expectedLength: 3,
    },
    {
      name: "bare @ (empty partial): files only, no kind noise, no sigils",
      params: { ...base, query: "" },
      expected: [
        { kind: "file", file: f("README.md") },
        { kind: "file", file: f("store", true) },
        { kind: "file", file: f("store.ts") },
      ],
    },
    {
      // Empty/unindexed cwd: no files for a bare `@` — fall back to sigil rows
      // so skill:/subagent:/model: stay discoverable instead of an empty menu.
      name: "bare @ with zero file candidates falls back to the sigil rows",
      params: {
        files: [],
        serverFiles: [],
        skills: SKILLS,
        subagents: SUBAGENTS,
        models: MODELS,
        query: "",
      },
      expected: [
        { kind: "sigil", prefix: "skill:", label: "browse skills…" },
        { kind: "sigil", prefix: "subagent:", label: "browse subagents…" },
        { kind: "sigil", prefix: "model:", label: "browse models…" },
      ],
    },
    {
      name: "bare @ with zero files AND empty skill/subagent lists still offers model: (always available)",
      params: {
        files: [],
        serverFiles: [],
        skills: [],
        subagents: [],
        models: [],
        query: "",
      },
      expected: [{ kind: "sigil", prefix: "model:", label: "browse models…" }],
    },
    {
      // serverFiles alone suppresses the sigil fallback just like local files —
      // there IS something to show, so don't inject sigil noise.
      name: "bare @ with server file extras (no local index) is not treated as zero candidates",
      params: {
        files: [],
        serverFiles: [f("README.md")],
        skills: SKILLS,
        subagents: SUBAGENTS,
        models: MODELS,
        query: "",
      },
      expected: [{ kind: "file", file: f("README.md") }],
    },
    {
      // "sk" matches the file + the skill: sigil, but not subagent:/model:.
      name: "'sk' shows the skill: sigil after file matches, not subagent:/model:",
      params: {
        files: [f("skills-doc.md"), f("readme.md")],
        serverFiles: [],
        skills: SKILLS, // neither "debug" nor "journal" contains "sk"
        subagents: SUBAGENTS, // neither contains "sk"
        models: MODELS, // none contain "sk"
        query: "sk",
      },
      expected: [
        { kind: "file", file: f("skills-doc.md") },
        { kind: "sigil", prefix: "skill:", label: "browse skills…" },
      ],
    },
    {
      name: "'s' matches both the skill: and subagent: sigils (not model:)",
      params: {
        files: [f("readme.md")], // no "s" in "readme.md"
        serverFiles: [],
        skills: SKILLS, // no "s" in "debug"/"journal"
        subagents: SUBAGENTS, // no "s" in "reviewer"/"explorer"
        models: [],
        query: "s",
      },
      expected: [
        { kind: "sigil", prefix: "skill:", label: "browse skills…" },
        { kind: "sigil", prefix: "subagent:", label: "browse subagents…" },
      ],
    },
    {
      name: "empty skill/subagent lists suppress their sigils; model: with 'm' is exempt",
      params: {
        files: [],
        serverFiles: [],
        skills: [],
        subagents: [],
        models: [], // still offers the model: sigil — models are always available
        query: "m",
      },
      expected: [{ kind: "sigil", prefix: "model:", label: "browse models…" }],
    },
    {
      // "s" with all-empty source lists matches no sigil → empty.
      name: "empty skill/subagent lists suppress their sigils; 's' yields empty",
      params: {
        files: [],
        serverFiles: [],
        skills: [],
        subagents: [],
        models: [],
        query: "s",
      },
      expected: [],
    },
    {
      name: "project mode appends badged skill/subagent/model matches after files, sigils last",
      params: {
        files: [f("modelo.txt")], // matches "model" as an interior/prefix substring
        serverFiles: [],
        skills: ["model-skill"],
        subagents: ["model-agent"],
        models: [m("x/model-9", "Model Nine")],
        query: "model",
      },
      expected: [
        { kind: "file", file: f("modelo.txt") },
        { kind: "skill", name: "model-skill" },
        { kind: "subagent", name: "model-agent" },
        { kind: "model", model: m("x/model-9", "Model Nine") },
        { kind: "sigil", prefix: "model:", label: "browse models…" },
      ],
    },
    {
      // No file/subagent/model matches "x" — just the capped, sorted skill badges.
      // (no sigil: "x" isn't a prefix of any sigil word).
      name: "badged matches per kind are capped at 5, alphabetical among equal ranks",
      params: {
        files: [],
        serverFiles: [],
        skills: ["x7", "x1", "x6", "x2", "x5", "x3", "x4"],
        subagents: [],
        models: [],
        query: "x",
      },
      expected: [
        { kind: "skill", name: "x1" },
        { kind: "skill", name: "x2" },
        { kind: "skill", name: "x3" },
        { kind: "skill", name: "x4" },
        { kind: "skill", name: "x5" },
      ],
    },
    {
      name: "server file extras are merged in after local matches, deduped by path",
      params: {
        files: [f("foo/a.ts")],
        serverFiles: [f("foo/a.ts"), f("bar/a.ts")],
        skills: [],
        subagents: [],
        models: [],
        query: "a.ts",
      },
      expected: [
        { kind: "file", file: f("foo/a.ts") },
        { kind: "file", file: f("bar/a.ts") },
      ],
    },
  ];
  for (const { name, params, expected, expectedLength } of buildCases) {
    test(name, () => {
      const items = buildAtItems(params);
      if (expectedLength !== undefined) {
        expect(items).toHaveLength(expectedLength);
      } else {
        expect(items).toEqual(expected satisfies AtItem[]);
      }
    });
  }
});

describe("splitExternalQuery", () => {
  test("bare tilde is the dir-prefix, empty partial", () => {
    expect(splitExternalQuery("~")).toEqual({ dirPrefix: "~", partial: "" });
  });
  test("bare .. is the dir-prefix, empty partial", () => {
    expect(splitExternalQuery("..")).toEqual({ dirPrefix: "..", partial: "" });
  });
  test("trailing slash: dir-prefix, empty partial", () => {
    expect(splitExternalQuery("~/projects/")).toEqual({
      dirPrefix: "~/projects",
      partial: "",
    });
  });
  test("root-anchored single segment keeps / as dir-prefix", () => {
    expect(splitExternalQuery("/etc")).toEqual({ dirPrefix: "/", partial: "etc" });
  });
  test("root-anchored dir + partial", () => {
    expect(splitExternalQuery("/etc/ho")).toEqual({
      dirPrefix: "/etc",
      partial: "ho",
    });
  });
  test("tilde dir + partial", () => {
    expect(splitExternalQuery("~/proj")).toEqual({
      dirPrefix: "~",
      partial: "proj",
    });
  });
});
