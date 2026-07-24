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

async function openMenu(page: Page): Promise<void> {
  await openDraft(page);
  await projectChip(page).click();
  await expect(projectMenu(page)).toBeVisible();
  // Move the mouse off the menu so no mouseenter fires on a result row
  // (the chip click leaves the cursor over the menu area).
  await page.mouse.move(0, 0);
}

test.beforeEach(async ({ page }) => gotoFresh(page));

test("known projects appear in the menu (AC.1)", async ({ page }) => {
  await openMenu(page);
  const results = projectMenu(page).locator(".result.project .name");
  // The mock fixtures define projects: pantoken, scratch, retry-lib, stale-proj.
  const names = await results.allTextContents();
  expect(names).toContain("pantoken");
  expect(names).toContain("scratch");
  expect(names).toContain("retry-lib");
  expect(names).toContain("stale-proj");
  // "New project…" entry is always present.
  await expect(projectMenu(page).getByText("New project…")).toBeVisible();
});

test("fuzzy search filters projects (AC.2)", async ({ page }) => {
  await openMenu(page);
  const input = projectMenu(page).getByRole("textbox", { name: "Filter projects" });
  await input.fill("pan");
  await expect(projectMenu(page).locator(".result.project .name")).toHaveText([
    "pantoken",
  ]);
  await input.fill("scr");
  await expect(projectMenu(page).locator(".result.project .name")).toHaveText([
    "scratch",
  ]);
});

test("selecting a project sets the draft cwd and closes the menu (AC.3)", async ({
  page,
}) => {
  await openMenu(page);
  await projectMenu(page).getByText("scratch").click();
  await expect(projectMenu(page)).toBeHidden();
  await expect(projectChip(page)).toContainText("scratch");
});

test("New project entry opens the DirPicker (AC.4)", async ({ page }) => {
  await openMenu(page);
  await projectMenu(page).getByText("New project…").click();
  await expect(projectMenu(page)).toBeHidden();
  await expect(page.getByTestId("dir-picker")).toBeVisible();
});

test("⌥P opens and closes the project menu (AC.5)", async ({ page }) => {
  await openDraft(page);
  await draftBox(page).focus();
  await page.keyboard.press("Alt+p");
  await expect(projectMenu(page)).toBeVisible();
  // Toggle off with ⌥P again.
  await page.keyboard.press("Alt+p");
  await expect(projectMenu(page)).toBeHidden();
  // Esc closes.
  await page.keyboard.press("Alt+p");
  await expect(projectMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(projectMenu(page)).toBeHidden();
});

test("keyboard navigation works (AC.6)", async ({ page }) => {
  await openMenu(page);
  const input = projectMenu(page).getByRole("textbox", { name: "Filter projects" });
  await expect(input).toBeFocused();
  // The first project (index 0) is highlighted by default — the most-recently-
  // used (pantoken in the fixture).
  await expect(
    projectMenu(page).locator(".result.project").first(),
  ).toHaveAttribute("aria-selected", "true");
  // Arrow down moves to the second project.
  await input.press("ArrowDown");
  await expect(
    projectMenu(page).locator(".result.project").nth(1),
  ).toHaveAttribute("aria-selected", "true");
  // Arrow up moves back to the first.
  await input.press("ArrowUp");
  await expect(
    projectMenu(page).locator(".result.project").first(),
  ).toHaveAttribute("aria-selected", "true");
  // Enter selects the highlighted project and closes the menu.
  await input.press("Enter");
  await expect(projectMenu(page)).toBeHidden();
  // The chip should now show the selected project (pantoken).
  await expect(projectChip(page)).toContainText("pantoken");
});

test("empty search shows a no-matches message", async ({ page }) => {
  await openMenu(page);
  const input = projectMenu(page).getByRole("textbox", { name: "Filter projects" });
  await input.fill("zzz");
  await expect(projectMenu(page).getByText("No matching projects.")).toBeVisible();
  // "New project…" remains available even with no matches.
  await expect(projectMenu(page).getByText("New project…")).toBeVisible();
  // Clearing the query restores the full list.
  await input.fill("");
  await expect(projectMenu(page).locator(".result.project")).toHaveCount(4);
});

test("active project is highlighted (AC.8)", async ({ page }) => {
  await openDraft(page);
  // The draft defaults to the viewed session's project (pantoken in the fixture).
  await projectChip(page).click();
  await expect(projectMenu(page)).toBeVisible();
  // The active project row carries aria-current="true".
  const active = projectMenu(page).locator(".result.project[aria-current='true']");
  await expect(active).toHaveCount(1);
  await expect(active.locator(".name")).toContainText("pantoken");
});
