import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Under create-on-click (phase 3), the project-selection UI lives in the
// session chooser (SessionChooser.svelte). On mobile the chooser renders as a
// full-screen overlay — the same shape the old draft project menu had.

const chooser = (page: Page) => page.getByTestId("session-chooser");

async function openChooser(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => gotoFresh(page));

test("mobile: full-screen overlay with touch targets and back gesture (AC.7)", async ({
  page,
}) => {
  await openChooser(page);
  // Wait for the reveal animation to settle before measuring bounding boxes.
  await page.waitForTimeout(200);

  // Full-screen overlay: covers the viewport.
  const chooserBox = await chooser(page).boundingBox();
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  expect(chooserBox).not.toBeNull();
  expect(chooserBox!.width).toBe(vw);
  expect(chooserBox!.height).toBe(vh);

  // Touch-safe targets: every result row is at least 44px tall.
  const rows = chooser(page).locator(".result");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await rows.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  // The search input is also touch-safe.
  const input = chooser(page).getByRole("textbox", {
    name: "Filter projects",
  });
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.height).toBeGreaterThanOrEqual(44);

  // Back gesture closes the chooser.
  await page.goBack();
  await expect(chooser(page)).toHaveCount(0);
});

test("mobile: selecting a project from the chooser creates a session", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();
  await chooser(page).getByTestId("chooser-project-scratch").click();
  await expect(chooser(page)).toHaveCount(0);
  // A new session row appears.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});
