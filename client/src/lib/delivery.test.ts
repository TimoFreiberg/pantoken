import { describe, expect, test } from "bun:test";
import { deliveryState } from "./delivery.js";

describe("deliveryState", () => {
  test("rejected overrides every connection state", () => {
    for (const conn of [
      "connected",
      "connecting",
      "reconnecting",
      "disconnected",
    ] as const) {
      expect(deliveryState("rejected", conn)).toBe("rejected");
    }
  });

  test("connected → sending regardless of outbox sub-state", () => {
    expect(deliveryState("sending", "connected")).toBe("sending");
    expect(deliveryState("queued", "connected")).toBe("sending");
  });

  test("disconnected → offline (truly queued)", () => {
    expect(deliveryState("queued", "disconnected")).toBe("offline");
    expect(deliveryState("sending", "disconnected")).toBe("offline");
  });

  test("mid-(re)connect → connecting, not offline (the bug this fixes)", () => {
    // send() can't get out yet, so the outbox sits at "queued" — but the prompt
    // goes the instant the socket is back, so it must not read "Queued offline".
    expect(deliveryState("queued", "connecting")).toBe("connecting");
    expect(deliveryState("queued", "reconnecting")).toBe("connecting");
  });
});
