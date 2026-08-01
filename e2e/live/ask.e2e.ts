import { expect, test } from "@playwright/test";
import { driveLive, gotoFreshLive } from "./helpers.js";

// LIVE tier (PANTOKEN_DRIVER=fake). See streaming.e2e.ts for the structural-only +
// unrun-in-session caveats.

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

test("an ask_user_question interrogative renders the inline Q&A form", async ({
  page,
}) => {
  await driveLive(page, "ask");

  // The ask-user-question corpus raises a qna interrogative → the inline Q&A form
  // (role=group "Questions", rendered in the chat column, not a floating dialog).
  // Question text is corpus-specific, so we assert the form's presence + that it
  // exposes an advance/submit control the operator can act on.
  const form = page.getByRole("group", { name: "Questions" });
  await expect(form).toBeVisible();
  // The corpus currently contains one question, so QnaForm renders its final-step
  // label ("Review answers") rather than "Next" or "Submit". Keep the assertion
  // structural across one- and multi-question corpus revisions.
  const controls = form.getByRole("button", {
    name: /Next|Review answers|Submit|Confirm/,
  });
  await expect(controls.first()).toBeVisible();
  while ((await controls.count()) > 0) {
    const button = controls.first();
    await button.click();
    await expect(button).toBeHidden({ timeout: 5_000 }).catch(() => undefined);
    if ((await form.count()) === 0) break;
  }
  await expect(page.getByRole("group", { name: "Questions" })).toHaveCount(0, {
    timeout: 10_000,
  });
});
