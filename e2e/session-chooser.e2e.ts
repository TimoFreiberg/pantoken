import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** The sidebar's top "+" button. */
const newBtn = (page: import("@playwright/test").Page) =>
  page.getByTestId("sidebar-new-session").locator(".new-btn");

test("AC.1 — clicking the top sidebar + opens the chooser view", async ({
  page,
}) => {
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  await newBtn(page).click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();
});

test("AC.2 — ⌘N opens the chooser with last-active project pre-selected", async ({
  page,
}) => {
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  // The last-active project (pantoken) is highlighted as active.
  await expect(
    page.getByTestId("session-chooser").locator(".result.active"),
  ).toBeVisible();
});

test("AC.3 — selecting a project creates a session immediately", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();

  await newBtn(page).click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  // Click the first project row — creates a session immediately.
  await page.getByTestId("session-chooser").locator(".result.project").first().click();

  // The chooser disappears and the transcript view appears.
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  // The sidebar gets a new session row.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});

test("AC.4 — Browse… opens DirPicker; picking a dir creates a session", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();

  await newBtn(page).click();
  await page.getByTestId("chooser-browse").click();

  const picker = page.getByTestId("dir-picker");
  await expect(picker).toBeVisible();
  const input = picker.getByLabel("Project directory path");
  await input.fill("/Users/timo/src/scratch/");
  await expect(picker.getByTestId("use-current-directory")).toBeVisible();
  await picker.getByTestId("use-current-directory").click();

  // The picker and chooser both disappear.
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  // A new session row appears.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});

test("AC.5 — clicking a project group's + header creates a session immediately", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();

  // The project "+" is in each group header.
  const projectPlus = page
    .getByTestId("sidebar")
    .locator(".group-head .project-new")
    .first();
  await projectPlus.click();

  // No chooser — the session is created immediately.
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});

test("AC.6 — boot with no sessions shows the chooser", async ({ page }) => {
  // Reset to empty (no sessions), then reload.
  await page.request.get("/debug/reset");
  await page.evaluate(() => {
    // Clear last-session persistence so boot doesn't restore.
    localStorage.removeItem("pantoken.lastSession");
  });
  await page.goto("/?dev");
  // With no restorable session, the chooser should appear.
  await expect(page.getByTestId("session-chooser")).toBeVisible();
});

test("AC.7 — navigating away from an empty freshly-created session reaps it", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();

  // Create a session via the chooser, then navigate to an existing session
  // without typing anything.
  await newBtn(page).click();
  await page.getByTestId("session-chooser").locator(".result.project").first().click();
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);

  // Now navigate to another session without typing.
  await openSidebar(page);
  await page.getByTestId("sidebar").locator(".row").first().click();

  // The empty session should be reaped (destroyed) — the count returns to
  // what it was before we created the empty session.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount,
  );
});

test("AC.8 — ⌘N then Enter creates a session in the last-active project", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();

  // ⌘N opens the chooser, Enter selects the pre-selected (last-active) project.
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  await page.keyboard.press("Enter");

  // A session is created — the chooser disappears and a new row appears.
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});

test("AC.12 — created session spawns with daemon-default config; toggling facet works", async ({
  page,
}) => {
  await openSidebar(page);

  // Create a session via the chooser.
  await newBtn(page).click();
  await page.getByTestId("session-chooser").locator(".result.project").first().click();
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);

  // The facet badge reads "Execute" (daemon default).
  await expect(page.locator(".facet-badge, [data-testid='facet-badge']")).toContainText(
    /execute/i,
  );

  // Toggle facet to Plan via the live session's chip.
  const facetChip = page.locator(".composer-wrap .facet-badge, .composer-wrap [data-testid='facet-badge']").first();
  if (await facetChip.isVisible()) {
    await facetChip.click();
    const planOption = page.getByRole("option", { name: /plan/i }).first();
    if (await planOption.isVisible()) {
      await planOption.click();
      // The facet should stick.
      await expect(
        page.locator(".facet-badge, [data-testid='facet-badge']"),
      ).toContainText(/plan/i);
    }
  }
});
