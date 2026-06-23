import { describe, expect, test } from "bun:test";
import { QueuedDeliveryTracker } from "./queued-delivery.js";

const userStart = { type: "message_start", message: { role: "user" } };
const assistantStart = {
  type: "message_start",
  message: { role: "assistant" },
};
const userUpdate = { type: "message_update", message: { role: "user" } };

describe("QueuedDeliveryTracker", () => {
  test("a user message_start with nothing pending is NOT a delivery (normal first prompt)", () => {
    const t = new QueuedDeliveryTracker();
    // The run-opening prompt's own message_start fires before any queuing is possible;
    // its bubble already showed via the optimistic send path, so leave it alone.
    expect(t.isDelivery(userStart)).toBe(false);
  });

  test("a queued send then a user message_start IS a delivery, consuming the slot", () => {
    const t = new QueuedDeliveryTracker();
    t.onQueued();
    expect(t.outstanding).toBe(1);
    expect(t.isDelivery(userStart)).toBe(true);
    expect(t.outstanding).toBe(0);
    // The same start arriving again (e.g. a later first prompt) is no longer a delivery.
    expect(t.isDelivery(userStart)).toBe(false);
  });

  test("counts FIFO: N queued sends consume across N deliveries, in order", () => {
    const t = new QueuedDeliveryTracker();
    t.onQueued();
    t.onQueued();
    t.onQueued();
    expect(t.outstanding).toBe(3);
    expect(t.isDelivery(userStart)).toBe(true);
    expect(t.isDelivery(userStart)).toBe(true);
    expect(t.isDelivery(userStart)).toBe(true);
    expect(t.outstanding).toBe(0);
    expect(t.isDelivery(userStart)).toBe(false);
  });

  test("only a role:user message_start counts — assistant starts and updates pass through", () => {
    const t = new QueuedDeliveryTracker();
    t.onQueued();
    // An assistant message_start while a delivery is pending must NOT consume the slot
    // (the queued user turn hasn't been injected yet).
    expect(t.isDelivery(assistantStart)).toBe(false);
    // A user message_UPDATE (delta) isn't an injection point either.
    expect(t.isDelivery(userUpdate)).toBe(false);
    expect(t.outstanding).toBe(1);
    // The real delivery still lands.
    expect(t.isDelivery(userStart)).toBe(true);
  });

  test("reset() drops undelivered messages (abort / clearQueue / run-end) so a later prompt is safe", () => {
    const t = new QueuedDeliveryTracker();
    t.onQueued();
    t.onQueued();
    t.reset();
    expect(t.outstanding).toBe(0);
    // A subsequent first prompt's message_start must not be mistaken for a delivery.
    expect(t.isDelivery(userStart)).toBe(false);
  });

  test("run-end (agent_end) reset: an error-stranded follow-up doesn't leak into the next run", () => {
    const t = new QueuedDeliveryTracker();
    t.onQueued(); // a follow-up queued mid-run
    // The run errors before delivering it; the driver resets on agent_end.
    t.reset();
    // Next run opens with a fresh prompt — its message_start must NOT steal the leftover's
    // slot (which would dupe the prompt and drop the follow-up live).
    expect(t.isDelivery(userStart)).toBe(false);
    expect(t.outstanding).toBe(0);
  });

  test("a partial drain then reset: delivered ones stay delivered, the rest are dropped", () => {
    const t = new QueuedDeliveryTracker();
    t.onQueued();
    t.onQueued();
    expect(t.isDelivery(userStart)).toBe(true); // one delivered
    t.reset(); // aborted before the second delivered
    expect(t.outstanding).toBe(0);
    expect(t.isDelivery(userStart)).toBe(false);
  });

  test("tolerates malformed events without throwing", () => {
    const t = new QueuedDeliveryTracker();
    t.onQueued();
    expect(t.isDelivery({})).toBe(false);
    expect(t.isDelivery({ type: "message_start" })).toBe(false);
    expect(t.isDelivery({ type: "message_start", message: {} })).toBe(false);
    expect(t.outstanding).toBe(1);
  });
});
