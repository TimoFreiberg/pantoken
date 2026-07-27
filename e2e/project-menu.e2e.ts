import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Under create-on-click (phase 3), the project menu lives in the session
// chooser (SessionChooser.svelte), not a draft composer chip. The chooser's
// project list uses the same deriveKnownProjects/rankProjects logic as the old
// draft project menu. These tests exercise the chooser's list, fuzzy filter,
// keyboard navigation, and Browse entry — the same coverage the old draft
// project-menu tests provided.

const chooser = (page: Page) => page.getByTestId("session-chooser");

async function openChooser(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();
  // Move the mouse off the chooser so no mouseenter fires on a result row.
  await page.mouse.move(0, 0);
}

test.beforeEach(async ({ page }) => gotoFresh(page));

test("known projects appear in the chooser (AC.1)", async ({ page }) => {
  await openChooser(page);
  const results = chooser(page).locator(".result.project .name");
  // The mock fixtures define projects: pantoken, scratch, retry-lib, stale-proj.
  const names = await results.allTextContents();
  expect(names).toContain("pantoken");
  expect(names).toContain("scratch");
  expect(names).toContain("retry-lib");
  expect(names).toContain("stale-proj");
  // "Browse…" entry is always present.
  await expect(chooser(page).getByTestId("chooser-browse")).toBeVisible();
});

test("fuzzy search filters projects (AC.2)", async ({ page }) => {
  await openChooser(page);
  const input = chooser(page).getByRole("textbox", { name: "Filter projects" });
  await input.fill("pan");
  await expect(chooser(page).locator(".result.project .name")).toHaveText([
    "pantoken",
  ]);
  await input.fill("scr");
  await expect(chooser(page).locator(".result.project .name")).toHaveText([
    "scratch",
  ]);
});

test("selecting a project creates a session and closes the chooser (AC.3)", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();

  // Click a project row — creates a session immediately and closes the chooser.
  await chooser(page).getByTestId("chooser-project-scratch").click();
  await expect(chooser(page)).toHaveCount(0);
  // A new session row appears.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});

test("Browse entry opens the DirPicker (AC.4)", async ({ page }) => {
  await openChooser(page);
  await chooser(page).getByTestId("chooser-browse").click();
  // The chooser stays mounted (the DirPicker renders as a sibling overlay on
  // top of it); the DirPicker is now visible.
  await expect(page.getByTestId("dir-picker")).toBeVisible();
});

test("keyboard navigation works (AC.6)", async ({ page }) => {
  await openChooser(page);
  const input = chooser(page).getByRole("textbox", { name: "Filter projects" });
  await expect(input).toBeFocused();
  // The first project (index 0) is highlighted by default — the most-recently-
  // used (pantoken in the fixture).
  await expect(
    chooser(page).locator(".result.project").first(),
  ).toHaveAttribute("aria-selected", "true");
  // Arrow down moves to the second project.
  await input.press("ArrowDown");
  await expect(
    chooser(page).locator(".result.project").nth(1),
  ).toHaveAttribute("aria-selected", "true");
  // Arrow up moves back to the first.
  await input.press("ArrowUp");
  await expect(
    chooser(page).locator(".result.project").first(),
  ).toHaveAttribute("aria-selected", "true");
  // Enter selects the highlighted project and closes the chooser (creates a
  // session).
  await input.press("Enter");
  await expect(chooser(page)).toHaveCount(0);
});

test("empty search shows a no-matches message", async ({ page }) => {
  await openChooser(page);
  const input = chooser(page).getByRole("textbox", { name: "Filter projects" });
  await input.fill("zzz");
  await expect(chooser(page).getByText("No matching projects.")).toBeVisible();
  // "Browse…" remains available even with no matches.
  await expect(chooser(page).getByTestId("chooser-browse")).toBeVisible();
  // Clearing the query restores the full list.
  await input.fill("");
  await expect(chooser(page).locator(".result.project")).toHaveCount(4);
});

test("active project is highlighted (AC.8)", async ({ page }) => {
  await openChooser(page);
  // The active project (last-active cwd) carries aria-current="true".
  // The greeting session lives in pantoken, so lastProjectCwd is pantoken.
  const active = chooser(page).locator(".result.project[aria-current='true']");
  await expect(active).toHaveCount(1);
  await expect(active.locator(".name")).toContainText("pantoken");
});
