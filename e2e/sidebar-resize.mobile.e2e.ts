import { expect, test } from "@playwright/test";
import { gotoFresh, openRightSidebar, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pantoken.sidebarWidth", "600");
    localStorage.setItem("pantoken.rightSidebarWidth", "500");
  });
  await gotoFresh(page);
});

test("mobile drawers keep responsive width and have no resize handle", async ({ page }) => {
  await openSidebar(page);
  await openRightSidebar(page);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toHaveCSS("width", /px$/);
  await expect(page.getByTestId("right-sidebar")).toHaveCSS("width", /px$/);
  expect(await page.getByTestId("sidebar").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
  expect(await page.getByTestId("right-sidebar").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
  await expect.poll(() => page.evaluate(() => ({
    left: localStorage.getItem("pantoken.sidebarWidth"),
    right: localStorage.getItem("pantoken.rightSidebarWidth"),
  }))).toEqual({ left: "600", right: "500" });
});
