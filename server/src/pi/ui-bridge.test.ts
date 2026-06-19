import { describe, expect, test } from "bun:test";
import type {
  HostUiRequest,
  SessionDriverEvent,
  SessionRef,
} from "@pilot/protocol";
import { PiUiBridge } from "./ui-bridge.js";
import { parseUnsupportedHostUiErrorMessage } from "./unsupported-host-ui.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };

function setup() {
  const events: SessionDriverEvent[] = [];
  let n = 0;
  const bridge = new PiUiBridge(
    ref,
    (e) => events.push(e),
    () => `t${n++}`,
  );
  const firstRequest = (): HostUiRequest => {
    const ev = events.find((e) => e.type === "hostUiRequest");
    if (!ev || ev.type !== "hostUiRequest")
      throw new Error("no hostUiRequest emitted");
    return ev.request;
  };
  const resolved = () => events.some((e) => e.type === "hostUiResolved");
  return { events, bridge, firstRequest, resolved };
}

describe("PiUiBridge", () => {
  test("confirm emits a request and resolves true on confirmed", async () => {
    const { bridge, firstRequest, resolved } = setup();
    const p = bridge.confirm("Title", "Msg");
    const req = firstRequest();
    expect(req.kind).toBe("confirm");
    bridge.resolve({ requestId: req.requestId, confirmed: true });
    expect(await p).toBe(true);
    expect(resolved()).toBe(true);
  });

  test("confirm resolves false on cancel", async () => {
    const { bridge, firstRequest } = setup();
    const p = bridge.confirm("T", "M");
    bridge.resolve({ requestId: firstRequest().requestId, cancelled: true });
    expect(await p).toBe(false);
  });

  test("select resolves with the chosen value", async () => {
    const { bridge, firstRequest } = setup();
    const p = bridge.select("Pick", ["a", "b"]);
    bridge.resolve({ requestId: firstRequest().requestId, value: "b" });
    expect(await p).toBe("b");
  });

  test("input resolves with the value", async () => {
    const { bridge, firstRequest } = setup();
    const p = bridge.input("Name");
    bridge.resolve({ requestId: firstRequest().requestId, value: "pilot" });
    expect(await p).toBe("pilot");
  });

  test("confirm times out to false (safe default)", async () => {
    const { bridge } = setup();
    expect(await bridge.confirm("T", "M", { timeout: 5 })).toBe(false);
  });

  test("a settled dialog ignores a second answer", async () => {
    const { bridge, firstRequest } = setup();
    const p = bridge.confirm("T", "M");
    const id = firstRequest().requestId;
    bridge.resolve({ requestId: id, confirmed: true });
    bridge.resolve({ requestId: id, confirmed: false }); // late — ignored
    expect(await p).toBe(true);
  });

  test("pending blocking requests can be replayed until they settle", async () => {
    const { bridge, firstRequest } = setup();
    const p = bridge.input("Name");
    const req = firstRequest();
    expect(bridge.pendingRequests()).toEqual([req]);
    bridge.resolve({ requestId: req.requestId, value: "pilot" });
    expect(await p).toBe("pilot");
    expect(bridge.pendingRequests()).toEqual([]);
  });

  test("notify and setStatus emit fire-and-forget requests", () => {
    const { events, bridge } = setup();
    bridge.notify("hello", "warning");
    bridge.setStatus("branch", "main");
    const kinds = events
      .filter((e) => e.type === "hostUiRequest")
      .map((e) => (e.type === "hostUiRequest" ? e.request.kind : ""));
    expect(kinds).toContain("notify");
    expect(kinds).toContain("status");
  });

  test("custom() rejects with a parseable terminal-only compat error", async () => {
    const { bridge } = setup();
    const err = await bridge.custom<unknown>().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    const issue = parseUnsupportedHostUiErrorMessage((err as Error).message);
    expect(issue?.capability).toBe("custom");
    expect(issue?.classification).toBe("terminal-only");
  });

  test("setWidget maps pi placement to composer placement", () => {
    const { events, bridge } = setup();
    bridge.setWidget("todo", ["x"], { placement: "belowEditor" });
    const w = events.find(
      (e) => e.type === "hostUiRequest" && e.request.kind === "widget",
    );
    expect(
      w &&
        w.type === "hostUiRequest" &&
        w.request.kind === "widget" &&
        w.request.placement,
    ).toBe("belowComposer");
  });

  // Replay-on-seed: the bridge owns ambient state because pi can't replay it across
  // a focus switch (DECISIONS.md D5).
  const seedReqs = (bridge: PiUiBridge): HostUiRequest[] =>
    bridge
      .ambientSeedEvents()
      .flatMap((e) => (e.type === "hostUiRequest" ? [e.request] : []));

  test("ambientSeedEvents replays retained status, widget, and title", () => {
    const { bridge } = setup();
    bridge.setStatus("branch", "on main");
    bridge.setWidget("tasklist", ["Open Tasks (1):", "  ○ #a1: do it"]);
    bridge.setTitle("My session");

    const reqs = seedReqs(bridge);
    const status = reqs.find((r) => r.kind === "status");
    const widget = reqs.find((r) => r.kind === "widget");
    const title = reqs.find((r) => r.kind === "title");
    expect(status && status.kind === "status" && status.text).toBe("on main");
    expect(widget && widget.kind === "widget" && widget.lines).toEqual([
      "Open Tasks (1):",
      "  ○ #a1: do it",
    ]);
    expect(title && title.kind === "title" && title.title).toBe("My session");
  });

  test("ambientSeedEvents drops cleared entries and keeps the latest value", () => {
    const { bridge } = setup();
    bridge.setStatus("branch", "on main");
    bridge.setStatus("branch", undefined); // cleared → not replayed
    bridge.setWidget("tasklist", ["one"]);
    bridge.setWidget("tasklist", ["two", "three"]); // overwrites
    bridge.setWidget("scratch", ["x"]);
    bridge.setWidget("scratch", undefined); // cleared → not replayed

    const reqs = seedReqs(bridge);
    expect(reqs.some((r) => r.kind === "status")).toBe(false);
    const widgets = reqs.filter((r) => r.kind === "widget");
    expect(widgets).toHaveLength(1);
    const w = widgets[0];
    expect(w && w.kind === "widget" && w.lines).toEqual(["two", "three"]);
  });
});
