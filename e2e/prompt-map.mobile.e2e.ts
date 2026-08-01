import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoFresh(page);
});

test("phone replaces arrows and desktop rail with a labeled outline sheet", async ({ page }) => {
  await drive(page, "reply");
  await expect(page.getByTestId("prompt-map")).toBeVisible();
  await expect(page.locator('[data-testid="prompt-map-tick"]:visible')).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-up")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-down")).toHaveCount(0);

  const trigger = page.getByTestId("prompt-map-trigger");
  await expect(trigger).toBeVisible();
  const box = await trigger.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await page.locator(".scroller").evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  await expect.poll(() => page.locator(".scroller").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await trigger.click();
  const sheet = page.getByTestId("prompt-map-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("prompt-map-row")).toHaveCount(2);
  await expect(sheet.getByTestId("prompt-map-row").last()).toHaveClass(/primary/);
});

test("selecting a phone outline row jumps and closes, while Back closes the sheet", async ({ page }) => {
  await drive(page, "reply");
  const trigger = page.getByTestId("prompt-map-trigger");
  await trigger.click();
  const sheet = page.getByTestId("prompt-map-sheet");
  await sheet.getByTestId("prompt-map-row").first().click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".row.user.nav-flash")).toHaveCount(1);

  await trigger.click();
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(sheet).toHaveCount(0);
});

test("Escape and scrim close the phone outline without stranded history", async ({ page }) => {
  await drive(page, "reply");
  const trigger = page.getByTestId("prompt-map-trigger");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("prompt-map-sheet")).toHaveCount(0);
  await trigger.click();
  await page.locator(".sheet-scrim").click({ position: { x: 2, y: 2 } });
  await expect(page.getByTestId("prompt-map-sheet")).toHaveCount(0);
});
