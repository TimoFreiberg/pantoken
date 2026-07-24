import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

const projectMenu = (page: Page) => page.getByTestId("project-menu");
const projectChip = (page: Page) => page.getByTestId("draft-project-control");
const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");

async function openDraft(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(draftBox(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => gotoFresh(page));

test("mobile: full-screen overlay with touch targets and back gesture (AC.7)", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(projectMenu(page)).toBeVisible();
  // Wait for the reveal animation to settle before measuring bounding boxes.
  await page.waitForTimeout(200);

  // Full-screen overlay: the scrim covers the viewport.
  const menuBox = await projectMenu(page).boundingBox();
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  expect(menuBox).not.toBeNull();
  expect(menuBox!.width).toBe(vw);
  expect(menuBox!.height).toBe(vh);

  // Touch-safe targets: every result row is at least 44px tall.
  const rows = projectMenu(page).locator(".result");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await rows.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  // The search input is also touch-safe.
  const input = projectMenu(page).getByRole("textbox", {
    name: "Filter projects",
  });
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.height).toBeGreaterThanOrEqual(44);

  // Back gesture closes the menu.
  await page.goBack();
  await expect(projectMenu(page)).toBeHidden();
  // Draft survives.
  await expect(draftBox(page)).toBeVisible();
});

test("mobile: selecting a project from the full-screen menu updates the chip", async ({
  page,
}) => {
  await openDraft(page);
  await projectChip(page).click();
  await expect(projectMenu(page)).toBeVisible();
  await projectMenu(page).getByText("scratch").click();
  await expect(projectMenu(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("scratch");
});
