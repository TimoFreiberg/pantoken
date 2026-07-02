import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// The fold is additive with exactly one destructive case: `sessionReset` clears
// the folded items so the driver's re-emitted transcript REPLACES the old one
// (the live driver emits this after /clear, rewind, or stream_discontinuity
// recovery). Without this spec no e2e exercises that path — a regression would
// show every reset as a duplicated transcript.
test("sessionReset replaces the transcript instead of duplicating it", async ({
  page,
}) => {
  // The greeting transcript is the boot fixture — its prompt is visible.
  await expect(
    page.getByText("Add a /health route to the server", { exact: false }),
  ).toBeVisible();

  await drive(page, "reset");

  // The replayed transcript arrives…
  await expect(
    page.getByText("Replayed prompt after the reset.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Transcript rebuilt from daemon history", { exact: false }),
  ).toBeVisible();

  // …and the pre-reset transcript is GONE (replaced, not appended-to).
  await expect(
    page.getByText("Add a /health route to the server", { exact: false }),
  ).toHaveCount(0);

  // Exactly one copy of the replayed prompt (no double-fold).
  await expect(
    page.locator(".row.user", { hasText: "Replayed prompt after the reset." }),
  ).toHaveCount(1);
});
