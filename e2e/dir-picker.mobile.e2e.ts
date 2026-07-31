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

// Journey: the project picker is a full-screen, touch-safe version of the
// desktop path picker; the visible Back button closes it and consumes its
// nested history entry.
test("project picker is full-screen and touch-safe; Back closes it via history", async ({
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

  // The visible Back button closes the picker…
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
  // …and browser Back consumes the nested history entry the same way.
  await page.goBack();
  await expect(picker(page)).toBeHidden();
  await expect(page.getByTestId("session-chooser")).toBeVisible();
});
