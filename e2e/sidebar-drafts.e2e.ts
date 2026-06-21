import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");

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

/** Start a new-session draft targeting the named project's group via its "+" button. */
async function newDraftIn(page: Page, proj: string) {
  await page.getByRole("button", { name: `New session in ${proj}` }).click();
}

test("a draft nests under its project and survives navigating away", async ({
  page,
}) => {
  await openSidebar(page);
  await newDraftIn(page, "pilot");
  await draftBox(page).fill("nest + persist");

  // While composing, the draft is the active row inside the pilot group.
  const pilotDraft = group(page, "pilot").getByTestId("draft-row");
  await expect(pilotDraft).toBeVisible();
  await expect(pilotDraft).toHaveClass(/\bactive\b/);

  // Navigate to an existing session — the draft row stays put (now idle), it doesn't
  // vanish the moment you look away.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(pilotDraft).toBeVisible();
  await expect(pilotDraft).not.toHaveClass(/\bactive\b/);
});

test("the × discards a draft", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pilot");
  await draftBox(page).fill("discard me");

  const pilotDraft = group(page, "pilot").getByTestId("draft-row");
  await expect(pilotDraft).toBeVisible();

  // Hover reveals the × on desktop; clicking it drops the draft entirely.
  await pilotDraft.hover();
  await page
    .getByRole("button", { name: "Discard this new-session draft" })
    .click();
  await expect(page.getByTestId("draft-row")).toHaveCount(0);
});

test("retargeting a draft moves its row to the new project — no ghost left behind", async ({
  page,
}) => {
  await openSidebar(page);
  await newDraftIn(page, "pilot");
  await draftBox(page).fill("moving");

  // Stash the draft under the pilot key by navigating away, then reopen it. This is the
  // case migration must handle: a retarget now has a stale stashed copy to clean up.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await group(page, "pilot").getByTestId("draft-row").click();

  // Retarget via the project chip → cwd input.
  await page.locator('button.chip[title^="Project:"]').click();
  await page.getByLabel("Project directory").fill("/Users/timo/src/scratch");
  await page.getByLabel("Project directory").press("Enter");

  // The row now lives under scratch, and pilot has no leftover ghost row.
  await expect(group(page, "scratch").getByTestId("draft-row")).toBeVisible();
  await expect(group(page, "pilot").getByTestId("draft-row")).toHaveCount(0);

  // Re-stash under the new key and confirm only scratch persists (the pilot key was
  // migrated away, not duplicated).
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(group(page, "scratch").getByTestId("draft-row")).toBeVisible();
  await expect(group(page, "pilot").getByTestId("draft-row")).toHaveCount(0);
});

test("a draft hides when its project group is collapsed", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pilot");
  await draftBox(page).fill("hide me");

  const pilot = group(page, "pilot");
  await expect(pilot.getByTestId("draft-row")).toBeVisible();

  // Collapsing the group hides the draft with it (the draft <li> rides the group's <ul>).
  await pilot.locator(".group-toggle").click();
  await expect(pilot.getByTestId("draft-row")).toBeHidden();
});
