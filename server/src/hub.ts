// The session hub: holds the authoritative folded SessionState, folds every
// driver event into it, and fans events out to all connected WS clients. New
// clients get hello + a full snapshot so they catch up without replaying history.

import {
  type ClientMessage,
  foldEvent,
  initialSessionState,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionDriverEvent,
  type SessionState,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";

export type Send = (msg: ServerMessage) => void;

/** What the hub hands to a notifier (e.g. the Web Push sender) for notable events. */
export interface HubNotification {
  title: string;
  body: string;
  tag?: string;
}

export class SessionHub {
  private state: SessionState = initialSessionState();
  private clients = new Set<Send>();
  private serverId = `pilot-${Math.floor(Date.now() / 1000)}`;
  // Whether any client has connected since startup. Gates push so the mock's
  // bootstrap replay (a greeting ending in runCompleted, fired while clientCount
  // is 0) doesn't buzz a stored subscription on every restart. The deeper fix —
  // distinguishing replayed history from live events — lands with persistence (D13).
  private everConnected = false;

  constructor(
    private driver: PilotDriver,
    // Called on run-done / approval-needed when NO client is connected, i.e. every
    // surface is backgrounded/closed — exactly when a Web Push should reach a pocket.
    private notify?: (n: HubNotification) => void,
  ) {
    driver.subscribe((ev) => this.onEvent(ev));
  }

  private onEvent(ev: SessionDriverEvent): void {
    foldEvent(this.state, ev);
    this.broadcast({ type: "event", event: ev });
    this.maybeNotify(ev);
  }

  // Mirror of the client's tab-open notify rules (App.svelte), but server-side and
  // only when no client is connected — a foreground tab handles its own buzzing.
  private maybeNotify(ev: SessionDriverEvent): void {
    // Push only when someone has been here and then left — never on a cold replay
    // (no one to "return" to a backgrounded app that was never opened).
    if (!this.notify || this.clients.size > 0 || !this.everConnected) return;
    if (ev.type === "runCompleted")
      this.notify({
        title: "pilot",
        body: "Agent finished its turn",
        tag: "pilot-run",
      });
    else if (ev.type === "runFailed")
      this.notify({ title: "pilot", body: "Run failed", tag: "pilot-run" });
    else if (ev.type === "hostUiRequest") {
      const kind = ev.request.kind;
      if (
        kind === "confirm" ||
        kind === "select" ||
        kind === "input" ||
        kind === "editor"
      ) {
        const r = ev.request as { title?: string };
        this.notify({
          title: "Approval needed",
          body: r.title ?? "Waiting on you",
          tag: "pilot-approval",
        });
      }
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const send of this.clients) {
      try {
        send(msg);
      } catch (e) {
        console.error("[hub] send failed", e);
      }
    }
  }

  /** Register a client. Synchronously sends hello + snapshot, then live events. */
  addClient(send: Send): () => void {
    this.clients.add(send);
    this.everConnected = true;
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverId: this.serverId,
    });
    send({ type: "snapshot", state: this.snapshot() });
    return () => this.clients.delete(send);
  }

  handleClient(send: Send, msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
      case "ping":
        return;
      case "prompt":
        this.driver.prompt(msg.text, msg.deliverAs);
        return;
      case "abort":
        this.driver.abort();
        return;
      case "respondUi": {
        // First-responder-wins: only the first answer for a still-pending dialog
        // reaches the driver. A second device answering the same id is dropped, so
        // the real pi session never gets a double resolution.
        const id = msg.response.requestId;
        if (!this.state.pendingApprovals.some((p) => p.requestId === id))
          return;
        this.driver.respondUi(msg.response);
        return;
      }
      case "mock":
        this.driver.runScript?.(msg.script);
        return;
      default:
        send({
          type: "error",
          message: `unknown message: ${(msg as { type: string }).type}`,
        });
    }
  }

  /** Dev/test-only: clear state, replay the initial fixture, re-snapshot clients. */
  reset(): void {
    this.state = initialSessionState();
    this.driver.reset?.();
    this.broadcast({ type: "snapshot", state: this.snapshot() });
  }

  /** A JSON-safe deep copy of current state (foldEvent mutates in place). */
  snapshot(): SessionState {
    return structuredClone(this.state);
  }

  clientCount(): number {
    return this.clients.size;
  }
}
