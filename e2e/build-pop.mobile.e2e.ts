import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Mobile build-stamp pop-up: on touch devices there's no hover, so tapping the
// version label pins the pop-up open (mirrors ContextMeter's click-to-pin).
// Runs in the mobile project (Pixel 7) — only *.mobile.e2e.ts files match.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("tapping the version label opens the pop-up", async ({ page }) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  const pop = page.getByTestId("build-pop");

  await expect(pop).toBeHidden();
  await version.tap();
  await expect(pop).toBeVisible();

  // Tapping again closes it (toggle pin).
  await version.tap();
  await expect(pop).toBeHidden();
});

test("version label meets 44px touch target", async ({ page }) => {
  await openSidebar(page);
  const label = page
    .getByTestId("sidebar")
    .getByTestId("version")
    .locator(".version-label");
  const box = await label.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
