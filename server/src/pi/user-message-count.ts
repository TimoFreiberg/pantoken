// Scanning the operator's own turns in a session file: how many, and when the last one
// landed.
//
// pi's SessionInfo.messageCount counts every message entry — user prompts, assistant
// replies, AND toolResult messages. A tool-heavy session shows "55 msg" for what was
// really 4 human prompts. The sidebar wants the human count, so we re-scan the .jsonl
// and count only entries whose message role is "user".
//
// We also pull the timestamp of the LAST role-"user" entry — the sidebar sorts by it
// ("most recently used on top") instead of by pi's `modified`/`updatedAt`, which the
// agent bumps on every streamed assistant turn (so sorting by it makes a running session
// jump as it emits tokens). A user-message timestamp only moves when the operator sends
// something, so the order is stable while a turn runs.
//
// This mirrors pi's own buildSessionInfo line-walk, but inspects only the role +
// timestamp, so it's far lighter than loading a session into an AgentSession. listAll()
// already streamed every file once; to avoid doing it again on every sidebar refresh we
// cache the result keyed by the file's mtime + pi's own total message count. Either
// changing (a new turn appended, the file rewritten) invalidates the entry — no extra
// stat() call, since both come free from the SessionInfo we already have.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Per-session scan result: the operator's turn count and when their last turn landed
 *  (epoch ms; `undefined` when the session has no user message yet). */
export interface UserMessageStats {
  readonly count: number;
  readonly lastUserAtMs: number | undefined;
}

interface CacheEntry extends UserMessageStats {
  readonly mtimeMs: number;
  readonly total: number;
}

const cache = new Map<string, CacheEntry>();

/** Operator turn count + last-user-message time for a session file. `mtimeMs` + `total`
 *  (pi's full message count) form the cache key — both are already known from the
 *  SessionInfo, so a steady sidebar refresh re-reads only files that changed. */
export async function userMessageStats(
  path: string,
  mtimeMs: number,
  total: number,
): Promise<UserMessageStats> {
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.total === total)
    return { count: hit.count, lastUserAtMs: hit.lastUserAtMs };

  const stats = await scanUserMessages(path);
  cache.set(path, { mtimeMs, total, ...stats });
  return stats;
}

/** Back-compat thin wrapper: just the count. */
export async function countUserMessages(
  path: string,
  mtimeMs: number,
  total: number,
): Promise<number> {
  return (await userMessageStats(path, mtimeMs, total)).count;
}

/** The activity time of a user message entry: prefer the numeric `message.timestamp`
 *  (epoch ms, as pi's own getMessageActivityTime does), else parse the entry-level ISO
 *  `timestamp` pi writes on every appended line. Returns undefined if neither parses. */
function userEntryTime(entry: {
  timestamp?: unknown;
  message?: { timestamp?: unknown };
}): number | undefined {
  const msgTs = entry.message?.timestamp;
  if (typeof msgTs === "number" && Number.isFinite(msgTs)) return msgTs;
  if (typeof entry.timestamp === "string") {
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

async function scanUserMessages(path: string): Promise<UserMessageStats> {
  let count = 0;
  let lastUserAtMs: number | undefined;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line) continue;
      // Cheap pre-filter: only "message" entries carry a role, and only "user" ones
      // count. Skip the JSON.parse for lines that can't match.
      if (!line.includes('"user"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn final line on a session being written — ignore it
      }
      if (
        entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "message" &&
        (entry as { message?: { role?: unknown } }).message?.role === "user"
      ) {
        count++;
        const t = userEntryTime(
          entry as { timestamp?: unknown; message?: { timestamp?: unknown } },
        );
        // Entries are appended in order, so the last user line we see is the latest;
        // max() guards against any out-of-order timestamps just in case.
        if (t !== undefined)
          lastUserAtMs =
            lastUserAtMs === undefined ? t : Math.max(lastUserAtMs, t);
      }
    }
  } finally {
    rl.close();
  }
  return { count, lastUserAtMs };
}
