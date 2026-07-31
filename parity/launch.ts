// parity/launch.ts — bring up pantoken (real polytoken driver) on fresh ports + isolated
// polytoken/pantoken state. Foreground; the caller keeps it alive (Claude_Preview manages it
// for `preview_start("pantoken-parity")`; `parity up` backgrounds it for the Playwright path).
//
// Self-contained on purpose (not delegating to scripts/dev.ts): dev.ts couples autoPort to
// "$PORT is set", and in autoPort mode it IGNORES PANTOKEN_DATA_DIR (per-port dir instead). We
// want PANTOKEN_DATA_DIR under PARITY_ROOT for one-rm-rf teardown, AND we want to record BOTH
// ports for the TUI side + `parity down`. So we own the spawn here. Mirrors dev.ts's
// health-gating, NODE_PATH fix-up, and child-cleanup.
//
// Isolation applied here:
//   PANTOKEN_DRIVER=polytoken         — the live daemon driver
//   PANTOKEN_AUTO_PORT unset, explicit PANTOKEN_PORT=<free>  — fresh backend, our own free port
//   PANTOKEN_DATA_DIR=<root>/pantoken-data                   — under PARITY_ROOT
//   PANTOKEN_TOKEN deleted             — tokenless (so /debug + the page are open)
//   PANTOKEN_IDLE_REAP_MS=<short>      — frees a session's exclusive TUI lease promptly so a
//                                     GUI→TUI handoff works without a 10-min wait
//   XDG_DATA_HOME / XDG_CACHE_HOME (+ XDG_CONFIG_HOME if isolating) — polytoken footprint

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManaged, sleep, isMain } from "../scripts/lib/node-compat.js";
import { resolveServerBinary } from "../scripts/lib/build-server.js";
import {
  ensureEnv,
  freePort,
  isolationEnv,
  paths,
  writeRunEnv,
  type Paths,
} from "./lib.ts";
import { ensureProject } from "./project.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Default short idle-reap for the harness (ms). Frees the exclusive lease ~quickly on an
 *  un-focused, idle session so GUI→TUI handoff via the reaper works (see flow 4b). */
const DEFAULT_REAP_MS = process.env.PANTOKEN_PARITY_IDLE_REAP_MS ?? "20000";

async function waitForHealth(
  base: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(150);
  }
  return false;
}

export async function launch(p: Paths = paths()): Promise<void> {
  ensureEnv(p);
  await ensureProject(p);

  // Vite needs a KNOWN port (an agent points a browser at it). Under Claude_Preview's
  // autoPort the harness passes $PORT; else take an explicit override; else a free port.
  // We NEVER let Vite fall back to 5173 (the agent-harness's own protected dev server).
  const vitePort = Number(
    process.env.PORT ??
      process.env.PANTOKEN_PARITY_VITE_PORT ??
      (await freePort()),
  );
  // Backend is always our own free port — immune to the desktop app's leaked PANTOKEN_PORT.
  const backendPort = Number(
    process.env.PANTOKEN_PARITY_BACKEND_PORT ?? (await freePort()),
  );
  // Use 127.0.0.1 everywhere: the backend binds 127.0.0.1 (config.host default), so a
  // `localhost` proxy/WS target could resolve to ::1 and miss it. Vite is bound to
  // 127.0.0.1 below too, so guiUrl is reachable by both curl and a browser.
  const serverUrl = `http://127.0.0.1:${backendPort}`;
  const guiUrl = `http://127.0.0.1:${vitePort}`;
  const wsUrl = `ws://127.0.0.1:${backendPort}/ws`;

  const backendEnv: Record<string, string | undefined> = {
    ...process.env,
    ...isolationEnv(p),
    PANTOKEN_DRIVER: "polytoken",
    PANTOKEN_PORT: String(backendPort),
    PANTOKEN_DATA_DIR: p.pantokenData,
    PANTOKEN_IDLE_REAP_MS: DEFAULT_REAP_MS,
    // Neutralize the desktop app's env leaks + force a tokenless, non-auto instance.
    PANTOKEN_AUTO_PORT: undefined,
    PANTOKEN_TOKEN: undefined,
    PORT: undefined,
  };

  // Build the server via Buck2 (same path as scripts/dev.ts) and spawn the
  // binary directly — cargo is no longer used here (buck2 is the primary
  // builder; cargo would leave target/ dirs behind without CARGO_TARGET_DIR).
  const serverBin = await resolveServerBinary(REPO_ROOT);
  const server = spawnManaged([serverBin], {
    env: backendEnv,
    stdout: "inherit",
    stderr: "inherit",
  });

  let shuttingDown = false;
  const procs = [server];
  function shutdown(code: number): never {
    shuttingDown = true;
    for (const proc of procs) {
      try {
        proc.kill(); // SIGTERM → the server disposes its warm daemons + releases leases
      } catch {
        /* gone */
      }
    }
    process.exit(code);
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("exit", () => {
    for (const proc of procs) {
      try {
        proc.kill();
      } catch {
        /* gone */
      }
    }
  });

  const healthy = await waitForHealth(serverUrl);
  if (!healthy) {
    console.error(`[parity] backend ${serverUrl}/health not ready — aborting`);
    shutdown(1);
  }

  // Launch Vite via npx (resolves from node_modules/.bin).
  const viteCmd = ["npx", "vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"];

  const vite = spawnManaged(
    viteCmd,
    {
      cwd: join(REPO_ROOT, "client"),
      env: {
        ...process.env,
        PANTOKEN_SERVER: serverUrl,
        VITE_PANTOKEN_WS_URL: wsUrl,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  procs.push(vite);

  writeRunEnv(
    {
      pantokenPid: process.pid,
      backendPort,
      vitePort,
      guiUrl,
      startedAt: new Date().toISOString(),
    },
    p,
  );

  console.error(
    `[parity] GUI ${guiUrl} · backend ${serverUrl} · sessions ${p.sessionsDir}`,
  );

  // If either child dies on its own, tear the stack down non-zero (mirrors dev.ts).
  void server.exited.then((c) => {
    if (!shuttingDown) {
      console.error(`[parity] backend exited (${c}) — shutting down`);
      shutdown(1);
    }
  });
  void vite.exited.then((c) => {
    if (!shuttingDown) {
      console.error(`[parity] vite exited (${c}) — shutting down`);
      shutdown(1);
    }
  });

  await Promise.all(procs.map((proc) => proc.exited));
}

if (isMain(import.meta.url)) {
  await launch();
}
