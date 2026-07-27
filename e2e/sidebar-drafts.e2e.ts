import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Draft rows are gone — no entry point creates drafts after phase 3. These
// tests now verify session-row behavior in the sidebar for sessions created
// via the project group "+" (create-on-click).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** The project group `<section>` whose header names `proj` (cwd basename). */
function group(page: Page, proj: string) {
  return page
    .getByTestId("sidebar")
    .locator("section.group")
    .filter({ has: page.locator(".proj", { hasText: proj }) });
}

function sessionRow(page: Page, title: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: title });
}

/** Create a new session in the named project via its group "+" button. */
async function newSessionIn(page: Page, proj: string) {
  await page.getByRole("button", { name: `New session in ${proj}` }).click();
}

test("a created session nests under its project and survives navigating away", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();
  await newSessionIn(page, "pantoken");

  // The new session row appears under the pantoken group.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );

  // The new session is the active row.
  await expect(page.getByTestId("sidebar").locator(".row.active")).toHaveCount(
    1,
  );

  // Send a prompt so the session is non-empty — phase 2 reaps empty sessions
  // on navigate-away (without a prompt the row would vanish).
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("keep me alive");
  await composer.press("Enter");

  // Navigate to an existing session — the new session row stays (idle).
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});

test("creating a session highlights only the new session — the previously focused session drops its highlight", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // The greeting session is focused (and highlighted) before any creation.
  const focusedRow = sidebar.locator("button.row", {
    hasText: "Wire up the WebSocket bridge",
  });
  await expect(focusedRow).toHaveClass(/\bactive\b/);

  await newSessionIn(page, "pantoken");

  // The new session is the only highlighted row in the sidebar.
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);
  await expect(focusedRow).not.toHaveClass(/\bactive\b/);

  // Navigate to the existing session — its highlight is restored, new session drops it.
  await focusedRow.click();
  await expect(focusedRow).toHaveClass(/\bactive\b/);
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);
});

test("a session row hides when its project group is collapsed", async ({
  page,
}) => {
  await openSidebar(page);
  await newSessionIn(page, "pantoken");

  const pantoken = group(page, "pantoken");
  // The newly created session row is visible under pantoken.
  const newRow = pantoken.locator(".row").last();
  await expect(newRow).toBeVisible();

  // Collapsing the group hides the session row with it.
  await pantoken.locator(".group-toggle").click();
  await expect(newRow).toBeHidden();
});
