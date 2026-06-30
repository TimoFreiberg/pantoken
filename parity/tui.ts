// parity/tui.ts — drive the polytoken TUI inside a dedicated tmux server.
//
// Isolation: the tmux server uses a per-root `-L <socket>` (NEVER the user's default
// server, so `kill-server` on teardown can't touch their real tmux), and EVERY pane is
// spawned with the full XDG_* isolation env injected via tmux `-e` (NOT just
// `--sessions-dir` — the TUI also writes logs/ + tui_state.json under XDG_DATA_HOME and a
// catalog cache under XDG_CACHE_HOME, which the flag does not redirect). `--sessions-dir`
// is passed too, belt-and-suspenders.
//
// Subcommands:
//   new                 — fresh TUI session in the test project; prints the new session id
//   attach <id>         — attach the TUI to a LIVE session
//   continue <id>       — resume a COLD session from history into the TUI
//   prompt <text>       — type <text> and submit (Enter)
//   type <text>         — type literal text (no submit)
//   keys <chord...>     — send raw chords (Enter, C-d, C-c, Y, Down, …)
//   capture             — print the rendered pane (capture-pane -p)
//   detach              — Ctrl+D (release the lease, leave the daemon running)
//   end                 — Ctrl+C ×2 (terminate the daemon), then wait until it's gone
//   ls                  — list live sessions in the ISOLATED registry
//   kill                — kill the dedicated tmux server

import {
  isolationEnv,
  paths,
  polytokenSessions,
  POLYTOKEN_BIN,
  TMUX_BIN,
  type LiveSession,
  type Paths,
} from "./lib.ts";
import { ensureProject } from "./project.ts";

const TMUX_SESSION = "parity";

function tmuxEnvArgs(p: Paths): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(isolationEnv(p)))
    args.push("-e", `${k}=${v}`);
  return args;
}

async function tmux(
  p: Paths,
  args: string[],
  opts: { check?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [TMUX_BIN, "-L", p.tmuxSocket, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (opts.check && code !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed (${code}): ${stderr.trim()}`,
    );
  }
  return { code, stdout, stderr };
}

async function hasSession(p: Paths): Promise<boolean> {
  const { code } = await tmux(p, ["has-session", "-t", TMUX_SESSION]);
  return code === 0;
}

/** (Re)launch a polytoken TUI command in a fresh tmux window on the dedicated server. */
async function launchTui(p: Paths, polytokenArgs: string[]): Promise<void> {
  await ensureProject(p);
  // Clean slate: kill any prior parity window (its TUI gets SIGHUP; an orphaned daemon, if
  // any, stays in the ISOLATED registry and is reaped by `parity down`).
  if (await hasSession(p)) {
    await tmux(p, ["kill-session", "-t", TMUX_SESSION]);
  }
  // Wrap the polytoken command so the pane SURVIVES the program exiting — without this, a
  // daemon that fails to start (e.g. config-load error when a provider key is unset) closes
  // the pane instantly and `tui capture` finds nothing. The trailing `sleep` keeps the pane
  // (and its scrollback) alive for inspection until the next `tui new`/`kill`. tmux runs a
  // single-string command through the shell, so the `;`-compound is honored. (Assumes the
  // sessions-dir path has no spaces — true under PARITY_ROOT.)
  const poly = [POLYTOKEN_BIN, ...polytokenArgs].join(" ");
  const cmd = `${poly}; printf '\\n[polytoken exited %s -- pane kept; rerun parity tui new]\\n' "$?"; sleep 86400`;
  await tmux(
    p,
    [
      "new-session",
      "-d",
      "-s",
      TMUX_SESSION,
      "-x",
      "220",
      "-y",
      "50",
      "-c",
      p.project,
      ...tmuxEnvArgs(p),
      cmd,
    ],
    { check: true },
  );
}

/** Poll until a NEW live session id appears (vs the pre-launch set), or time out. */
async function waitForNewSession(
  p: Paths,
  before: Set<string>,
  timeoutMs = 20_000,
): Promise<LiveSession | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = await polytokenSessions(p);
    const fresh = live.find((s) => !before.has(s.sessionId));
    if (fresh) return fresh;
    await Bun.sleep(250);
  }
  return null;
}

async function sendKeys(
  p: Paths,
  keys: string[],
  literal: boolean,
): Promise<void> {
  if (!(await hasSession(p))) {
    throw new Error(
      "no parity TUI session — run `parity tui new|attach|continue` first",
    );
  }
  const flag = literal ? ["-l"] : [];
  await tmux(p, ["send-keys", "-t", TMUX_SESSION, ...flag, ...keys], {
    check: true,
  });
}

export async function tuiCommand(
  argv: string[],
  p: Paths = paths(),
): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "new": {
      const before = new Set(
        (await polytokenSessions(p)).map((s) => s.sessionId),
      );
      await launchTui(p, ["new", "--sessions-dir", p.sessionsDir]);
      const fresh = await waitForNewSession(p, before);
      if (!fresh) {
        throw new Error(
          "TUI session did not appear in 20s — check `parity tui capture` (auth/config?)",
        );
      }
      console.log(fresh.sessionId);
      break;
    }
    case "attach": {
      const id = rest[0];
      if (!id) throw new Error("usage: tui attach <session-id>");
      await launchTui(p, ["attach", id, "--sessions-dir", p.sessionsDir]);
      console.log(`attached ${id}`);
      break;
    }
    case "continue": {
      const id = rest[0];
      if (!id) throw new Error("usage: tui continue <session-id>");
      await launchTui(p, ["continue", id, "--sessions-dir", p.sessionsDir]);
      console.log(`continuing ${id}`);
      break;
    }
    case "type": {
      await sendKeys(p, [rest.join(" ")], true);
      break;
    }
    case "prompt": {
      const text = rest.join(" ");
      await sendKeys(p, [text], true);
      await Bun.sleep(150); // let the TUI settle the input before submit
      await sendKeys(p, ["Enter"], false);
      break;
    }
    case "keys": {
      if (!rest.length)
        throw new Error("usage: tui keys <chord...>  (e.g. Enter C-d Y)");
      await sendKeys(p, rest, false);
      break;
    }
    case "capture": {
      const { stdout } = await tmux(
        p,
        ["capture-pane", "-p", "-t", TMUX_SESSION],
        {
          check: true,
        },
      );
      process.stdout.write(stdout);
      break;
    }
    case "detach": {
      await sendKeys(p, ["C-d"], false); // detach-session: leave daemon running
      break;
    }
    case "end": {
      // end-session = Ctrl+C twice, back-to-back (before the flash expires).
      await sendKeys(p, ["C-c"], false);
      await sendKeys(p, ["C-c"], false);
      // Confirm the daemon actually exited rather than assuming.
      const id = rest[0];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const live = await polytokenSessions(p);
        if (!id || !live.some((s) => s.sessionId === id)) break;
        await Bun.sleep(200);
      }
      break;
    }
    case "ls": {
      const live = await polytokenSessions(p);
      if (!live.length) console.log("(no live isolated sessions)");
      for (const s of live)
        console.log(`${s.sessionId}\t:${s.port}\t${s.projectPath}`);
      break;
    }
    case "kill": {
      await tmux(p, ["kill-server"]);
      break;
    }
    default:
      throw new Error(
        `unknown tui subcommand: ${sub ?? "(none)"} — ` +
          `new|attach|continue|prompt|type|keys|capture|detach|end|ls|kill`,
      );
  }
}

if (import.meta.main) {
  try {
    await tuiCommand(process.argv.slice(2));
  } catch (e) {
    console.error(`[parity tui] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
