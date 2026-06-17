// The pilot WebSocket envelope. Wraps the vendored session-driver event stream
// with connection bootstrap (snapshot-on-connect) and client commands.
//
// M0 is single-session: the server has one active session and omits a session id
// from messages. A `sessionId` field will be threaded through at M5 (multi-session)
// without changing these shapes structurally.

import type {
  HostUiResponse,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
} from "./session-driver.js";
import type { SessionState } from "./state.js";

export const PROTOCOL_VERSION = 1;

export type ServerMessage =
  | { type: "hello"; protocolVersion: number; serverId: string }
  /** Full authoritative state — sent on (re)connect so clients catch up. */
  | { type: "snapshot"; state: SessionState }
  /** One incremental driver event to fold. */
  | { type: "event"; event: SessionDriverEvent }
  /** The sessions available to open + which one is active (server-authoritative).
   *  Kept separate from `snapshot` because it's cross-session meta-state, not the
   *  folded transcript of the active session. */
  | {
      type: "sessionList";
      sessions: readonly SessionListEntry[];
      activeSessionId: SessionId | null;
    }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "hello"; auth?: string }
  | { type: "prompt"; text: string; deliverAs?: "steer" | "followUp" }
  | { type: "abort" }
  | { type: "respondUi"; response: HostUiResponse }
  /** Switch the active session to this .jsonl path. */
  | { type: "openSession"; path: string }
  /** Create a fresh session (in the server's cwd) and make it active. */
  | { type: "newSession" }
  /** Ask the server to re-scan disk and re-broadcast the session list. */
  | { type: "listSessions" }
  /** Dev-only: drive the mock fixture to a named scripted state. */
  | { type: "mock"; script: string }
  | { type: "ping" };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.type === "string")
      return v as ClientMessage;
  } catch {
    /* drop */
  }
  return null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.type === "string")
      return v as ServerMessage;
  } catch {
    /* drop */
  }
  return null;
}
