import { describe, expect, test } from "bun:test";
import type { CommandInfo, McpServerInfo } from "@pantoken/protocol";
import {
  filterCommands,
  filterMcpActions,
  filterMcpServers,
  mcpArgStage,
  parseSlashCommand,
  slashQuery,
} from "./slash.js";

const CMDS: CommandInfo[] = [
  { name: "review", source: "prompt", argumentHint: "[path]" },
  { name: "plan", source: "prompt" },
  { name: "pr", source: "extension" },
  { name: "core-review", source: "extension" },
  { name: "skill:debug", source: "skill" },
];

describe("slashQuery", () => {
  test("returns the text after a leading slash with no whitespace", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/skill:de")).toBe("skill:de");
  });

  test("is inactive once the name is settled or the draft isn't a slash token", () => {
    expect(slashQuery("/review src")).toBeNull(); // space → typing args now
    expect(slashQuery("/review\n")).toBeNull(); // newline counts as whitespace
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery("")).toBeNull();
    expect(slashQuery(" /review")).toBeNull(); // leading space, not a command
  });
});

describe("filterCommands", () => {
  test("empty query returns every command, alphabetical", () => {
    expect(filterCommands(CMDS, "").map((c) => c.name)).toEqual([
      "core-review",
      "plan",
      "pr",
      "review",
      "skill:debug",
    ]);
  });

  test("prefix matches rank above interior matches", () => {
    // "review" (prefix) before "core-review" (interior)
    expect(filterCommands(CMDS, "review").map((c) => c.name)).toEqual([
      "review",
      "core-review",
    ]);
  });

  test("is case-insensitive and matches interior substrings", () => {
    expect(filterCommands(CMDS, "DEBUG").map((c) => c.name)).toEqual([
      "skill:debug",
    ]);
  });

  test("prefix group is sorted alphabetically among ties", () => {
    // "p" prefixes: "plan", "pr" → alphabetical
    expect(filterCommands(CMDS, "p").map((c) => c.name)).toEqual([
      "plan",
      "pr",
    ]);
  });

  test("no match yields an empty list", () => {
    expect(filterCommands(CMDS, "zzz")).toEqual([]);
  });
});

describe("parseSlashCommand", () => {
  test("extracts a bare command name with no args", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
  });

  test("extracts a command name and args", () => {
    expect(parseSlashCommand("/compact summary text")).toEqual({
      name: "compact",
      args: "summary text",
    });
  });

  test("extracts a namespaced command name", () => {
    expect(parseSlashCommand("/skill:debug")).toEqual({
      name: "skill:debug",
      args: "",
    });
  });

  test("extracts args that look like file paths", () => {
    expect(parseSlashCommand("/review src/foo.ts")).toEqual({
      name: "review",
      args: "src/foo.ts",
    });
  });

  test("returns null for non-slash text", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  test("trims leading whitespace before checking for a slash", () => {
    expect(parseSlashCommand("  /clear")).toEqual({
      name: "clear",
      args: "",
    });
  });

  test("returns null for a bare slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
  });

  test("returns null when a space immediately follows the slash", () => {
    expect(parseSlashCommand("/ foo")).toBeNull();
  });
});

const SERVERS: McpServerInfo[] = [
  { serverName: "filesystem", status: "connected", toolCount: 11 },
  { serverName: "github", status: "disconnected", toolCount: 0 },
];

describe("mcpArgStage", () => {
  test("null when the name is still being typed (no space)", () => {
    expect(mcpArgStage("/mcp")).toBeNull();
    expect(mcpArgStage("/mc")).toBeNull();
    expect(mcpArgStage("/mcpx ")).toBeNull(); // /mcpx is not /mcp
  });

  test("null for unrelated drafts", () => {
    expect(mcpArgStage("hello")).toBeNull();
    expect(mcpArgStage("/clear")).toBeNull();
    expect(mcpArgStage("")).toBeNull();
    expect(mcpArgStage("/review src")).toBeNull();
  });

  test("server stage with an empty partial right after the space", () => {
    expect(mcpArgStage("/mcp ")).toEqual({ stage: "server", partial: "", serverName: "" });
  });

  test("server stage with a partial being typed", () => {
    expect(mcpArgStage("/mcp play")).toEqual({ stage: "server", partial: "play", serverName: "" });
    expect(mcpArgStage("/mcp file")).toEqual({ stage: "server", partial: "file", serverName: "" });
  });

  test("action stage with an empty partial right after the second space", () => {
    expect(mcpArgStage("/mcp playwright ")).toEqual({
      stage: "action",
      partial: "",
      serverName: "playwright",
    });
  });

  test("action stage with a partial being typed", () => {
    expect(mcpArgStage("/mcp playwright en")).toEqual({
      stage: "action",
      partial: "en",
      serverName: "playwright",
    });
  });

  test("serverName carries through to the action stage", () => {
    expect(mcpArgStage("/mcp filesystem dis")?.serverName).toBe("filesystem");
  });

  test("collapses consecutive whitespace into a single separator", () => {
    expect(mcpArgStage("/mcp  filesystem")).toEqual({
      stage: "server",
      partial: "filesystem",
      serverName: "",
    });
    expect(mcpArgStage("/mcp  filesystem  ")).toEqual({
      stage: "action",
      partial: "",
      serverName: "filesystem",
    });
  });

  test("past the action stage (3+ tokens) returns null", () => {
    expect(mcpArgStage("/mcp filesystem disable extra")).toBeNull();
  });

  test("is case-insensitive on the command name", () => {
    expect(mcpArgStage("/MCP filesystem ")).toEqual({
      stage: "action",
      partial: "",
      serverName: "filesystem",
    });
    expect(mcpArgStage("/Mcp play")).toEqual({ stage: "server", partial: "play", serverName: "" });
  });

  test("is cursor-aware: mid-token cursor returns the partial up to the cursor", () => {
    // draft "/mcp filesystem dis|able" with cursor before "able"
    expect(mcpArgStage("/mcp filesystem disable", "/mcp filesystem dis".length)).toEqual({
      stage: "action",
      partial: "dis",
      serverName: "filesystem",
    });
  });

  test("is cursor-aware: cursor before the separator is null (slash menu owns it)", () => {
    expect(mcpArgStage("/mcp filesystem disable", "/mcp".length)).toBeNull();
  });
});

describe("filterMcpServers", () => {
  test("empty query returns every server", () => {
    expect(filterMcpServers(SERVERS, "").map((s) => s.serverName)).toEqual([
      "filesystem",
      "github",
    ]);
  });

  test("substring filter narrows the list", () => {
    expect(filterMcpServers(SERVERS, "file").map((s) => s.serverName)).toEqual([
      "filesystem",
    ]);
  });

  test("no match yields an empty list", () => {
    expect(filterMcpServers(SERVERS, "zzz")).toEqual([]);
  });

  test("prefix matches rank above interior matches", () => {
    const mixed: McpServerInfo[] = [
      { serverName: "myserver", status: "connected", toolCount: 0 },
      { serverName: "server-x", status: "connected", toolCount: 0 },
    ];
    // "server-x" is a prefix match (at===0); "myserver" is interior (at===2).
    expect(filterMcpServers(mixed, "server").map((s) => s.serverName)).toEqual([
      "server-x",
      "myserver",
    ]);
  });
});

describe("filterMcpActions", () => {
  test("empty query returns all four actions (alphabetical)", () => {
    // All are prefix matches (at===0), so ties break alphabetically.
    expect(filterMcpActions("").map((a) => a.action)).toEqual([
      "disable",
      "disconnect",
      "enable",
      "reconnect",
    ]);
  });

  test("prefix filter narrows", () => {
    expect(filterMcpActions("dis").map((a) => a.action)).toEqual([
      "disable",
      "disconnect",
    ]);
  });

  test("reconnect is matched by 're'", () => {
    expect(filterMcpActions("re").map((a) => a.action)).toEqual(["reconnect"]);
  });

  test("no match yields an empty list", () => {
    expect(filterMcpActions("zzz")).toEqual([]);
  });
});
