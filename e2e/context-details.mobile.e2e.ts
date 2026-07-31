import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openRightSidebar } from "./helpers.js";

// Issue #55 regression: on mobile, JobDetail/TodoDetail sheets must render
// ABOVE the full-screen Context view (z-index fix) and the Back gesture must
// close the detail sheet first, then the Context view (overlay-history
// integration). Runs under the "mobile" project (Pixel 7, *.mobile.e2e.ts).
//
// toBeVisible() alone doesn't catch z-index occlusion — Playwright visibility
// doesn't check whether another element paints on top. The tests also CLICK an
// element inside the detail (the close button): Playwright's actionability check
// fails if the pointer target is covered by the Context view.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** Drive the mock to the "context" state (3 flagged files + 3 jobs + 3 todos),
 *  then open the full-screen Context view. */
async function openContextWithFixtures(page: import("@playwright/test").Page) {
  await drive(page, "context");
  await openRightSidebar(page);
}

test("tapping a job opens a visible, interactable detail above the context view", async ({
  page,
}) => {
  await openContextWithFixtures(page);
  // Tap the first job ("general-purpose").
  await page.locator(".job-btn").first().click();

  const detail = page.getByTestId("job-detail");
  await expect(detail).toBeVisible();
  // Interactability: clicking the close button must succeed — it would throw
  // if the Context view covered the detail (Issue #55 root cause).
  await detail.getByRole("button", { name: "Close job detail" }).click();
  await expect(detail).toHaveCount(0);
});

test("Back closes the job detail first, then the context view", async ({
  page,
}) => {
  await openContextWithFixtures(page);
  await page.locator(".job-btn").first().click();
  const detail = page.getByTestId("job-detail");
  await expect(detail).toBeVisible();
  const context = page.getByTestId("right-sidebar");

  // First Back: closes the job detail, Context view stays open.
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await expect(context).toHaveAttribute("data-open", "true");

  // Second Back: closes the Context view.
  await page.goBack();
  await expect(context).toHaveAttribute("data-open", "false");
});

test("collapsing context via hotkey while a detail is open closes both", async ({
  page,
}) => {
  await openContextWithFixtures(page);
  await page.locator(".job-btn").first().click();
  await expect(page.getByTestId("job-detail")).toBeVisible();

  // The detail scrim (z=100) covers the Context view (z=80), so the collapse
  // button is not clickable while a detail is open — correct modal behavior.
  // The ⌘⇧J hotkey (StatusHeader → toggleRightSidebar → closeRightSidebar) is
  // the path that still works: closeRightSidebar() closes the detail first
  // (consuming its nested history entry), then the Context view. This verifies
  // the in-order cleanup with no orphaned sheet (AC.4, collapse-triggered path).
  await page.keyboard.press("Control+Shift+KeyJ");

  await expect(page.getByTestId("job-detail")).toHaveCount(0);
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
});

test("collapse button is reachable after closing the detail, no orphaned sheet", async ({
  page,
}) => {
  // AC.4 realistic path: while a detail is open the collapse button is covered
  // by the modal scrim; close the detail first (✕), then the collapse button is
  // interactive and closes the Context view. No orphaned detail remains.
  await openContextWithFixtures(page);
  const context = page.getByTestId("right-sidebar");
  await page.locator(".job-btn").first().click();
  const detail = page.getByTestId("job-detail");
  await expect(detail).toBeVisible();

  // Close the detail — scrim lifts, Context view's collapse button is exposed.
  await detail.getByRole("button", { name: "Close job detail" }).click();
  await expect(detail).toHaveCount(0);
  await expect(context).toHaveAttribute("data-open", "true");

  // Now the collapse button is clickable and closes the Context view.
  await context
    .getByRole("button", { name: "Collapse context panel" })
    .click();
  await expect(context).toHaveAttribute("data-open", "false");
  // No orphaned detail sheet over the transcript.
  await expect(page.getByTestId("job-detail")).toHaveCount(0);
});
