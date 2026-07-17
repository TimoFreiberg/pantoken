import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// The PlanView overlay surfaces the daemon's active_plan (the plan facet's
// structured plan document) as a modal rendering of the plan markdown. Triggered
// by a StatusHeader button that appears only when activePlan is non-empty.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the plan button appears, opens the overlay, and Escape closes it", async ({
  page,
}) => {
  // Before driving `planview`: no activePlan → no Plan button.
  await expect(page.getByTestId("plan-view-toggle")).toHaveCount(0);

  // Drive the planview fixture → a snapshot with activePlan lands.
  await drive(page, "planview");

  // The Plan button appears in the StatusHeader.
  const planBtn = page.getByTestId("plan-view-toggle");
  await expect(planBtn).toBeVisible();

  // Click it → the PlanView modal opens with the plan markdown rendered.
  await planBtn.click();
  const modal = page.getByTestId("plan-view");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Wire up the plan overlay");

  // Escape closes the modal.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("⌘P toggles the plan view overlay", async ({ page }) => {
  await drive(page, "planview");
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();

  // ⌘P opens the overlay.
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toBeVisible();

  // ⌘P again closes it.
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toHaveCount(0);
});

test("a new-session draft hides the plan button and makes ⌘P inert", async ({
  page,
}) => {
  await drive(page, "planview");
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();

  // In the draft view store.session still holds the previous session's plan, but
  // PlanView is unmounted — the button must hide and ⌘P must not flip its state.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  await expect(page.getByTestId("plan-view-toggle")).toHaveCount(0);

  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toHaveCount(0);

  // Returning to the session restores the button (state wasn't corrupted).
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .locator(".row", { hasText: "Wire up the WebSocket bridge" })
    .click();
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();
});

test("the overlay renders the full plan markdown", async ({ page }) => {
  await drive(page, "planview");
  await page.getByTestId("plan-view-toggle").click();
  const modal = page.getByTestId("plan-view");
  await expect(modal).toBeVisible();

  // The plan's heading + body render (the Markdown.svelte path).
  const body = page.getByTestId("plan-view-body");
  await expect(body).toContainText("Wire up the plan overlay");
  await expect(body).toContainText("SessionSnapshot protocol");
  await expect(body).toContainText("event-map");
  await expect(body).toContainText("read-only");

  // Escape closes.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});
