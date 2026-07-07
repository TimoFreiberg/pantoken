import { expect, test } from "@playwright/test";
import { driveLive, gotoFreshLive } from "./helpers.js";

// LIVE tier (PILOT_DRIVER=fake). See streaming.e2e.ts for the structural-only +
// unrun-in-session caveats.

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

test("a mid-flight queued prompt surfaces in the queue tray", async ({ page }) => {
  await driveLive(page, "queue");

  // The queue-while-in-flight corpus emits pending_turn_input_queued → the driver's
  // RefetchQueue effect → queueUpdated. Structurally: the queue tray appears with at
  // least one queued row. Content (the queued text) is corpus-specific, so we assert
  // the tray + its "Queued" label, not a fixture string.
  const tray = page.getByTestId("queue-tray");
  await expect(tray).toBeVisible();
  await expect(tray).toContainText("Queued");
});
