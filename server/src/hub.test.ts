import { describe, expect, test } from "bun:test";
import type {
  HostUiResponse,
  ServerMessage,
  SessionDriverEvent,
  SessionRef,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";
import { SessionHub } from "./hub.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const ev = (e: Partial<SessionDriverEvent>): SessionDriverEvent =>
  ({ sessionRef: ref, timestamp: "t", ...e }) as SessionDriverEvent;

/** A driver we can emit into by hand, for deterministic hub tests. */
class FakeDriver implements PilotDriver {
  private listener?: (e: SessionDriverEvent) => void;
  readonly responded: HostUiResponse[] = [];
  subscribe(l: (e: SessionDriverEvent) => void) {
    this.listener = l;
    return () => {};
  }
  emit(e: SessionDriverEvent) {
    this.listener?.(e);
  }
  prompt() {}
  abort() {}
  respondUi(r: HostUiResponse) {
    this.responded.push(r);
    this.emit(ev({ type: "hostUiResolved", requestId: r.requestId }));
  }
}

function client() {
  const received: ServerMessage[] = [];
  return { send: (m: ServerMessage) => received.push(m), received };
}

describe("SessionHub", () => {
  test("a new client gets hello then a snapshot", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    expect(a.received[0]?.type).toBe("hello");
    expect(a.received[1]?.type).toBe("snapshot");
  });

  test("events broadcast to all connected clients", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send);
    hub.addClient(b.send);
    d.emit(ev({ type: "assistantDelta", text: "hi", channel: "text" }));
    expect(a.received.at(-1)).toMatchObject({ type: "event" });
    expect(b.received.at(-1)).toMatchObject({ type: "event" });
  });

  test("snapshot-on-connect reflects prior events without re-sending them", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "userMessage", id: "u1", text: "earlier" }));
    const late = client();
    hub.addClient(late.send);
    const snap = late.received.find((m) => m.type === "snapshot");
    expect(snap?.type).toBe("snapshot");
    if (snap?.type === "snapshot") {
      expect(
        snap.state.items.some((i) => i.kind === "user" && i.text === "earlier"),
      ).toBe(true);
    }
    // the late client must NOT have received the prior event as a live event
    expect(late.received.some((m) => m.type === "event")).toBe(false);
  });

  test("first-responder-wins: a second answer to the same dialog is dropped", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send);
    hub.addClient(b.send);
    d.emit(
      ev({
        type: "hostUiRequest",
        request: { kind: "confirm", requestId: "r1", title: "t", message: "m" },
      }),
    );

    hub.handleClient(a.send, {
      type: "respondUi",
      response: { requestId: "r1", confirmed: true },
    });
    hub.handleClient(b.send, {
      type: "respondUi",
      response: { requestId: "r1", confirmed: false },
    });

    expect(d.responded).toHaveLength(1);
    expect(d.responded[0]).toMatchObject({ confirmed: true });
  });
});
