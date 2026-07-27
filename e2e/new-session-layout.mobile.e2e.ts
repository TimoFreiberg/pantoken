import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
});

test("mobile centres the chooser and keeps its controls usable", async ({
  page,
}) => {
  const view = page.getByTestId("session-chooser");
  await expect(view).toBeVisible();
  const searchInput = view.getByLabel("Filter projects");
  await expect(searchInput).toBeVisible();

  // The composition is within the viewport bounds.
  const viewBox = await view.boundingBox();
  expect(viewBox).not.toBeNull();
  const shellBox = await page.locator(".shell").boundingBox();
  expect(shellBox).not.toBeNull();
  expect(viewBox!.y).toBeGreaterThanOrEqual(shellBox!.y - 0.5);
  expect(viewBox!.y + viewBox!.height).toBeLessThanOrEqual(
    shellBox!.y + shellBox!.height + 0.5,
  );

  // Project rows are tappable (44px touch targets).
  const projectRow = view.getByTestId("chooser-project-pantoken");
  await expect(projectRow).toBeVisible();
  const rowBox = await projectRow.boundingBox();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);

  // The Browse entry is also reachable.
  await expect(view.getByTestId("chooser-browse")).toBeVisible();
});

test("mobile keyboard inset keeps the chooser bounded above the keyboard", async ({
  page,
}) => {
  const searchInput = page.getByLabel("Filter projects");
  await searchInput.focus();

  await page.evaluate(() =>
    document.documentElement.style.setProperty("--keyboard-inset", "260px"),
  );

  const shell = page.locator(".shell");
  const view = page.getByTestId("session-chooser");
  await expect
    .poll(() => shell.evaluate((el) => el.clientHeight))
    .toBeLessThan(600);
  const shellBox = await shell.boundingBox();
  const viewBox = await view.boundingBox();
  expect(shellBox).not.toBeNull();
  expect(viewBox).not.toBeNull();
  expect(viewBox!.y).toBeGreaterThanOrEqual(shellBox!.y - 0.5);
  expect(viewBox!.y + viewBox!.height).toBeLessThanOrEqual(
    shellBox!.y + shellBox!.height + 0.5,
  );
});
