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
});
