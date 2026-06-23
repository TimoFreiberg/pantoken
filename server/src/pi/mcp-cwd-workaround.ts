// TEMPORARY WORKAROUND — remove when pi-mcp-adapter ships the upstream fix.
//
// pi-mcp-adapter (<= 2.10.0) spawns stdio MCP servers with cwd = the host
// process's process.cwd(), ignoring the per-session cwd it already receives
// (ctx.cwd). Pilot runs every session in ONE process, so every session's MCP
// servers (e.g. the playwright browser server) root at pilot's own dir. Servers
// that write files relative to their cwd — playwright screenshots especially —
// then drop them in pilot's dir instead of the session's worktree, where the
// agent looks, so the agent resorts to scanning the filesystem to find them.
//
// Stopgap: generate a per-session copy of the user's global mcp.json with `cwd`
// injected into every stdio server, and point the adapter at it via its
// `mcp-config` flag (passed through `extensionFlagValues`). The adapter reads
// that flag per session and spawns servers at the injected cwd.
//
// Upstream fix (local branch, PR pending): default the spawn cwd to ctx.cwd in
// McpServerManager.connect(). Once that ships and is installed, delete this
// file, its import, and the call site in pi-driver.ts (warmUp). Tracked in
// docs/TODO.md ("Remove the MCP-cwd workaround once the pi-mcp-adapter fix ships").
//
// Limitation: only the pi-global config (`<agentDir>/mcp.json`) is rewritten.
// Servers contributed by the adapter's other config sources (shared ~/.config
// /mcp, project .mcp.json, host imports) are not touched — fine for the current
// single-source setup, and moot once the upstream fix lands.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface McpServerDef {
  command?: string;
  url?: string;
  cwd?: string;
  [key: string]: unknown;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerDef>;
  [key: string]: unknown;
}

/**
 * Write a per-session MCP config — a copy of `<agentDir>/mcp.json` with `cwd`
 * injected into each stdio server — and return its path, or `undefined` when
 * there is nothing to override (no global config, malformed config, or no
 * stdio servers). The path is meant to be passed to the adapter via the
 * `mcp-config` extension flag.
 */
export function buildSessionMcpConfigOverride(
  agentDir: string,
  cwd: string,
): string | undefined {
  const source = join(agentDir, "mcp.json");
  if (!existsSync(source)) return undefined;

  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(readFileSync(source, "utf-8")) as McpConfigFile;
  } catch {
    // Malformed config: don't override, let pi surface the error itself.
    return undefined;
  }

  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== "object") return undefined;

  let injected = false;
  for (const def of Object.values(servers)) {
    // Only stdio (command-based) servers spawn a process and write relative to
    // cwd; url servers don't. Respect an explicit cwd already in config.
    if (def && typeof def === "object" && def.command && !def.cwd) {
      def.cwd = cwd;
      injected = true;
    }
  }
  if (!injected) return undefined;

  // mcp.json can carry secrets (env, auth headers) in some setups, so keep the
  // generated copy user-private.
  const dir = join(tmpdir(), "pilot-mcp-config");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  const file = join(dir, `${key}.json`);
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return file;
}
