import { describe, expect, test } from "bun:test";
import type {
  HostUiResponse,
  ServerMessage,
  SessionDriverEvent,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";
import { SessionHub } from "./hub.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const ev = (e: Partial<SessionDriverEvent>): SessionDriverEvent =>
  ({ sessionRef: ref, timestamp: "t", ...e }) as SessionDriverEvent;
const evFor = (
  sessionId: string,
  e: Partial<SessionDriverEvent>,
): SessionDriverEvent =>
  ({
    sessionRef: { workspaceId: "w", sessionId },
    timestamp: "t",
    ...e,
  }) as SessionDriverEvent;
const snap = (sessionId: string): SessionSnapshot => ({
  ref: { workspaceId: "w", sessionId },
  workspace: { workspaceId: "w", path: "/w" },
  title: "t",
  status: "idle",
  updatedAt: "t",
});
const flush = () => new Promise((r) => setTimeout(r, 0));

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
  async listSessions(): Promise<SessionListEntry[]> {
    return [
      {
        sessionId: "s",
        path: "/s.jsonl",
        cwd: "/w",
        preview: "a",
        messageCount: 1,
        updatedAt: "t",
        createdAt: "t",
      },
      {
        sessionId: "s2",
        path: "/s2.jsonl",
        cwd: "/w",
        preview: "b",
        messageCount: 2,
        updatedAt: "t",
        createdAt: "t",
      },
    ];
  }
  async openSession(_path: string): Promise<SessionDriverEvent[]> {
    return [
      ev({ type: "sessionOpened", snapshot: snap("s2") }),
      ev({ type: "userMessage", id: "u2", text: "new session" }),
    ];
  }
  async newSession(): Promise<SessionDriverEvent[]> {
    return [ev({ type: "sessionOpened", snapshot: snap("new") })];
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

  test("a connecting client eventually receives the session list", async () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    await flush();
    const list = a.received.find((m) => m.type === "sessionList");
    expect(list?.type).toBe("sessionList");
    if (list?.type === "sessionList")
      expect(list.sessions.length).toBeGreaterThan(0);
  });

  test("openSession resets to the new session's seed and re-snapshots clients", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "userMessage", id: "u1", text: "old session msg" }));
    const a = client();
    hub.addClient(a.send);

    hub.handleClient(a.send, { type: "openSession", path: "/s2.jsonl" });
    await flush();

    const lastSnap = a.received.filter((m) => m.type === "snapshot").at(-1);
    expect(lastSnap?.type).toBe("snapshot");
    if (lastSnap?.type === "snapshot") {
      // old session's transcript is gone, the new seed is in
      expect(
        lastSnap.state.items.some((i) => i.text === "old session msg"),
      ).toBe(false);
      expect(lastSnap.state.items.some((i) => i.text === "new session")).toBe(
        true,
      );
    }
    // the session list now reports the switched-to session as active
    const lastList = a.received.filter((m) => m.type === "sessionList").at(-1);
    if (lastList?.type === "sessionList")
      expect(lastList.activeSessionId).toBe("s2");
  });

  test("only the focused session broadcasts to clients (D8 global focus)", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "assistantDelta", text: "focused", channel: "text" })); // focus "s"
    const a = client();
    hub.addClient(a.send);
    a.received.length = 0; // drop hello/snapshot

    // A background session's event must NOT reach the client's transcript stream.
    d.emit(
      evFor("s2", { type: "assistantDelta", text: "bg", channel: "text" }),
    );
    expect(a.received.some((m) => m.type === "event")).toBe(false);

    // A focused-session event still does.
    d.emit(ev({ type: "assistantDelta", text: "more", channel: "text" }));
    expect(a.received.some((m) => m.type === "event")).toBe(true);
  });

  test("a background turn finishing while away still notifies", () => {
    const notes: { tag?: string }[] = [];
    const d = new FakeDriver();
    const hub = new SessionHub(d, (n) => {
      notes.push(n);
    });
    const a = client();
    const leave = hub.addClient(a.send); // everConnected = true
    d.emit(ev({ type: "assistantDelta", text: "focus s", channel: "text" })); // focus "s"
    leave(); // client gone → clients.size 0

    d.emit(evFor("s2", { type: "runCompleted", snapshot: snap("s2") }));
    expect(notes.some((n) => n.tag === "pilot-run")).toBe(true);
  });

  test("commands target msg.sessionId, else the focused session", () => {
    const calls: (string | undefined)[] = [];
    class RecordingDriver extends FakeDriver {
      prompt(_t: string, _d?: "steer" | "followUp", sessionId?: string) {
        calls.push(sessionId);
      }
    }
    const d = new RecordingDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "assistantDelta", text: "x", channel: "text" })); // focus "s"

    hub.handleClient(() => {}, { type: "prompt", text: "hi" }); // → focused "s"
    hub.handleClient(() => {}, { type: "prompt", text: "yo", sessionId: "s2" });
    expect(calls).toEqual(["s", "s2"]);
  });
});
