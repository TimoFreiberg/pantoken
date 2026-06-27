// Tiny dependency-free structured logger. Writes JSON-lines to `dataDir/pilot.log`
// (one `{ts, level, msg, ...fields}` object per line) AND mirrors a human-readable
// line to the console, so `bun run dev` stays readable while a durable log
// accumulates for after-the-fact debugging.
//
// Size-based rotation with node:fs only (no pino, no logrotate): when the active
// file crosses ~5MB we roll pilot.log -> pilot.log.1 -> pilot.log.2 ... up to a
// cap, pruning the oldest. Rotation is checked before each append; a single
// oversized line still gets written (we roll, then write it fresh).
//
// The server-id (see pidlock.ts) is attached to every line once it's known, so
// log lines are attributable to a specific server instance / data dir.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /** Absolute path to the active log file (e.g. `dataDir/pilot.log`). */
  file: string;
  /** Roll once the active file is at/over this many bytes. Default ~5MB. */
  maxBytes?: number;
  /** How many rolled generations to keep (pilot.log.1 .. .N). Default 3. */
  maxGenerations?: number;
  /** Stable server id, stamped onto every line when set. */
  serverId?: string;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_GENERATIONS = 3;

type Fields = Record<string, unknown>;

/** Stringify a console.* argument the way the platform would for a human-readable line:
 *  strings as-is, Errors as `name: message`, everything else via JSON (truncated so a
 *  huge object can't blow up the log line). Mirrors Node/Bun's console rendering closely
 *  enough for the `source: "console"` lines to read like the terminal would. */
function stringifyForConsole(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const json = JSON.stringify(value);
    return json.length > 2000 ? `${json.slice(0, 2000)}…(truncated)` : json;
  } catch {
    return String(value);
  }
}

/**
 * Rotate `file` if it is at/over `maxBytes`. Shifts generations down
 * (file.N-1 -> file.N, dropping the old file.N), then file -> file.1. Keeps at
 * most `maxGenerations` rolled files. Returns true if a roll happened.
 *
 * Pure-ish (touches the filesystem only); exported for unit testing the policy
 * without going through the Logger.
 */
export function rotateIfNeeded(
  file: string,
  maxBytes: number,
  maxGenerations: number,
): boolean {
  if (!existsSync(file)) return false;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;

  // Drop the oldest generation if it's at the cap, then shift each down by one.
  // With maxGenerations=3 we keep .1 .2 .3; the would-be .4 is pruned.
  const oldest = `${file}.${maxGenerations}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      // ignore — best effort
    }
  }
  for (let i = maxGenerations - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        // ignore — best effort
      }
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    return false;
  }
  return true;
}

export class Logger {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxGenerations: number;
  private serverId: string | undefined;

  constructor(opts: LoggerOptions) {
    this.file = opts.file;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxGenerations = opts.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
    this.serverId = opts.serverId;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  /** Stamp every subsequent line with this server-id (set once it's known). */
  setServerId(id: string): void {
    this.serverId = id;
  }

  debug(msg: string, fields?: Fields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.write("error", msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Fields): void {
    const ts = new Date().toISOString();
    const record: Fields = { ts, level, msg };
    if (this.serverId) record.serverId = this.serverId;
    if (fields) Object.assign(record, fields);

    // Console mirror first — it must never be blocked by a disk problem. Uses the
    // captured originals (see captureConsole) so a tee'd console.* doesn't recurse.
    this.mirrorToConsole(level, ts, msg, fields);

    try {
      rotateIfNeeded(this.file, this.maxBytes, this.maxGenerations);
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
    } catch (e) {
      // Don't let a logging failure take down the server. Surface it on the
      // console (which still works) so it isn't silent.
      this.originalConsole.error(
        "[log] failed to write log file",
        this.file,
        e,
      );
    }
  }

  private mirrorToConsole(
    level: LogLevel,
    ts: string,
    msg: string,
    fields?: Fields,
  ): void {
    const id = this.serverId ? ` ${this.serverId.slice(0, 8)}` : "";
    const extra =
      fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    const line = `[pilot${id}] ${ts} ${level} ${msg}${extra}`;
    if (level === "error") this.originalConsole.error(line);
    else if (level === "warn") this.originalConsole.warn(line);
    else this.originalConsole.log(line);
  }

  // Captured at construction, before captureConsole() swaps the globals — so the
  // Logger's own mirror writes go to the REAL stdout/stderr, never back through the tee
  // (which would recurse: console.error -> write() -> mirrorToConsole -> console.error).
  private readonly originalConsole: Pick<
    Console,
    "log" | "warn" | "error" | "debug"
  > = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  /** Tee global console.* into this log file as `console`/level lines, in addition to
   *  their normal stderr/stdout output. This is how pi extension `console.error` (and
   *  pilot's own `[pi] ...` lines) reach `pilot.log` in the live desktop app, where the
   *  process stderr is otherwise unreached (ServerSupervisor attaches no stderr pipe).
   *  Must be called AFTER construction — the originals are captured in the constructor so
   *  the Logger's own mirror path never recurses through the tee.
   *
   *  The log line carries `source: "console"` so it's distinguishable from structured
   *  Logger calls; arguments are stringified like the platform would (.join(' ')). */
  captureConsole(): void {
    const self = this;
    const tee =
      (level: LogLevel) =>
      (...args: unknown[]): void => {
        const msg = args.map((a) => stringifyForConsole(a)).join(" ");
        self.write(level, msg, { source: "console" });
        // The write() above already mirrored to the real stderr/stdout via the captured
        // originals — don't also call them here, or every line prints twice.
      };
    console.log = tee("info") as Console["log"];
    console.info = tee("info") as Console["info"];
    console.warn = tee("warn") as Console["warn"];
    console.error = tee("error") as Console["error"];
    console.debug = tee("debug") as Console["debug"];
  }

  /** Restore the global console.* captured at construction time. Pairs with
   *  captureConsole() so tests can swap back; production never calls this. */
  restoreConsole(): void {
    console.log = this.originalConsole.log;
    console.info = this.originalConsole.info;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    console.debug = this.originalConsole.debug;
  }
}
