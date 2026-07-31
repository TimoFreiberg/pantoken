import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// When creating a new session fails (e.g. the real driver's daemon spawn
// hits an error), the warm-up placeholder must NOT leave the user stuck on a
// "Starting session…" view. The error handler clears `creatingSession` and
// reopens the chooser so the user can retry or pick a different project.
// `drive(page, "failnewsession")` arms a one-shot mock newSession() rejection.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a failed create-on-click clears the warm-up placeholder and returns to the chooser", async ({
  page,
}) => {
  // Open the chooser.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  // Arm the one-shot creation failure BEFORE selecting a project (the mock
  // rejects the next newSession() call).
  await drive(page, "failnewsession");

  // Select a project — createSession fires immediately, the mock fails.
  await page
    .getByTestId("session-chooser")
    .locator(".result.project")
    .first()
    .click();

  // The warm-up indicator must NOT be stuck — creatingSession is cleared.
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);

  // The chooser reappears so the user can retry.
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  // The error is surfaced (lastError renders in the sidebar as an alert).
  await expect(page.getByRole("alert")).toContainText(
    "Could not create the new session",
  );
});
