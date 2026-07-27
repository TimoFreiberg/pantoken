import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

const picker = (page: Page) => page.getByTestId("dir-picker");
const input = (page: Page) => page.getByLabel("Project directory path");

/** Open the chooser, then the DirPicker via the Browse… button. */
async function openPicker(page: Page): Promise<void> {
  await gotoFresh(page);
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  await page.getByTestId("chooser-browse").click();
  await expect(picker(page)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(input(page)).toBeFocused();
}

test("project picker is a full-screen, touch-safe version of the desktop path picker", async ({
  page,
}) => {
  await openPicker(page);
  const box = await picker(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBe(viewport.width);
  expect(box!.height).toBe(viewport.height);
  await input(page).fill("/Users/timo/src/pi");
  const row = picker(page).locator(".directory").first();
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(picker(page).locator("footer")).toBeHidden();
});

test("browser Back closes the picker and returns to the chooser", async ({
  page,
}) => {
  await openPicker(page);
  await page.goBack();
  await expect(picker(page)).toBeHidden();
  // The chooser is still visible after closing the DirPicker via Back.
  await expect(page.getByTestId("session-chooser")).toBeVisible();
});

test("visible Back closes the picker and consumes its nested history entry", async ({
  page,
}) => {
  await openPicker(page);
  await picker(page)
    .getByRole("button", { name: "Close project picker" })
    .first()
    .click();
  await expect(picker(page)).toBeHidden();
  // The chooser is still visible — reopening the DirPicker from it works.
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  await page.getByTestId("chooser-browse").click();
  await expect(picker(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await page.goBack();
  await expect(picker(page)).toBeHidden();
  await expect(page.getByTestId("session-chooser")).toBeVisible();
});
