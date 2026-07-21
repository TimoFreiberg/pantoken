import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  waitForSettledWorkBlocks,
} from "./helpers.js";

// Regression for #78: a delayed background-agent notification must not collapse
// the preceding settled final assistant response behind "Worked for Ns." The
// `latenotify` mock script emits: narration → tool → finalA (settled via
// RunCompleted) → HostUiRequest::Notify (the late notice) → follow-up (settled
// via RunCompleted). Without the fix, the notice breaks the trailing-run scan,
// finalA folds into `work`, and only the short follow-up stays visible.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a late notification keeps the settled response visible and out of the work block", async ({
  page,
}) => {
  // The greeting has already settled (gotoFresh waited for 1 work block).
  // Drive the late-notification sequence on top of it.
  await drive(page, "latenotify");

  // Wait for the follow-up to appear and the turn to settle: two settled work
  // blocks now exist (the greeting + the late-notify turn).
  await waitForSettledWorkBlocks(page, 2);

  // AC.2: the settled response (finalA) is visible — not hidden behind a
  // collapsed work block.
  const finalAText = "Build succeeded with no warnings";
  await expect(page.getByText(finalAText, { exact: false })).toBeVisible();

  // AC.3: the delayed notification renders as separate, non-destructive content.
  await expect(
    page.getByText("Subagent general-purpose: Success", { exact: false }),
  ).toBeVisible();

  // The follow-up is also visible (the trailing response).
  await expect(
    page.getByText("Noted — the background subagent finished successfully", {
      exact: false,
    }),
  ).toBeVisible();

  // Expand the latest turn's work block and assert finalA is NOT inside the
  // work body — it remains visible outside it (promoted to a pinned lane).
  await expandWork(page, "last");
  const workBody = page.getByTestId("work-body").last();
  await expect(workBody).toBeVisible();
  // finalA must not appear inside the expanded work body.
  await expect(
    workBody.getByText(finalAText, { exact: false }),
  ).toHaveCount(0);
  // But it IS visible somewhere on the page (outside the work body).
  await expect(page.getByText(finalAText, { exact: false })).toBeVisible();

  // AC.5: the greeting's response is still visible (no regression to the prior turn).
  await expect(page.getByText("Routes live in", { exact: false })).toBeVisible();
});
