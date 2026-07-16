import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the Stop pill aligns with the composer on mobile", async ({ page }) => {
  await drive(page, "streamhold");

  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();

  const stopBox = await stop.boundingBox();
  const composerBox = await page.getByTestId("composer-surface").boundingBox();
  expect(stopBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(stopBox!.x).toBeCloseTo(composerBox!.x, 1);
});
