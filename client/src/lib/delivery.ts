import type { PendingPrompt } from "./prompt-outbox.js";
import type { ConnectionState } from "./ws.svelte.js";

export type DeliveryState = "sending" | "connecting" | "offline" | "rejected";

/**
 * The delivery label for an optimistic (not-yet-acknowledged) prompt row.
 *
 * An optimistic row only exists until the server's authoritative `userMessage`
 * arrives, so any row still showing is in flight — its label tracks the *socket*,
 * not the outbox sub-state (which sits at "queued" whenever `send()` couldn't get
 * out, i.e. for BOTH a dead socket and one mid-reconnect). Keying off the prompt's
 * own state was the bug: a prompt about to go out the instant the socket returns
 * read as "Queued offline", more stuck than it actually was.
 *
 *  - rejected          → terminal, overrides everything (stays with Retry/Edit)
 *  - connected         → "sending" (send is in flight or imminent)
 *  - connecting / reconnecting → "connecting" (goes out the moment the socket is back)
 *  - disconnected      → "offline" (truly queued, no attempt in flight)
 */
export function deliveryState(
  promptState: PendingPrompt["state"],
  connection: ConnectionState,
): DeliveryState {
  if (promptState === "rejected") return "rejected";
  if (connection === "connected") return "sending";
  if (connection === "disconnected") return "offline";
  return "connecting";
}
