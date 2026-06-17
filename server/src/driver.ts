// The seam between the WS hub and whatever produces session events. The mock
// driver and the real pi-sdk driver both implement this, so the hub never changes
// when we swap the fixture for a live agent.

import type {
  HostUiResponse,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
} from "@pilot/protocol";

export interface PilotDriver {
  subscribe(listener: (ev: SessionDriverEvent) => void): () => void;
  // sessionId targets a specific (warm) session; omit it to act on the session
  // the driver currently treats as active. Single-session drivers ignore it.
  prompt(
    text: string,
    deliverAs?: "steer" | "followUp",
    sessionId?: SessionId,
  ): void;
  abort(sessionId?: SessionId): void;
  respondUi(response: HostUiResponse, sessionId?: SessionId): void;

  /** Sessions on disk available to open (D13: pi's .jsonl files are authoritative). */
  listSessions(): Promise<SessionListEntry[]>;
  /**
   * Switch the active session to the given .jsonl path. Resolves with the SEED
   * events (a `sessionOpened` + the replayed history) for the now-active session;
   * the hub resets its state and folds them. The driver must NOT also emit these
   * via `subscribe` — the hub orchestrates the reset so the swap is atomic.
   */
  openSession(path: string): Promise<SessionDriverEvent[]>;
  /** Create a fresh session (in the driver's cwd) and make it active; resolves with
   *  its seed events (an empty `sessionOpened`). */
  newSession(): Promise<SessionDriverEvent[]>;

  /** Dev-only: jump the mock to a named scripted state. No-op for the real driver. */
  runScript?(name: string): void;
  /** Dev/test-only: clear all state and replay the initial fixture. No-op for real. */
  reset?(): void;
}
