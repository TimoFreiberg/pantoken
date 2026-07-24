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
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("nest + persist");

  // While composing, the draft is the active row inside the pantoken group.
  const pantokenDraft = group(page, "pantoken").getByTestId("draft-row");
  await expect(pantokenDraft).toBeVisible();
  await expect(pantokenDraft).toHaveClass(/\bactive\b/);

  // Navigate to an existing session — the draft row stays put (now idle), it doesn't
  // vanish the moment you look away.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(pantokenDraft).toBeVisible();
  await expect(pantokenDraft).not.toHaveClass(/\bactive\b/);
});

test("opening a draft highlights only the draft — the previously focused session drops its highlight", async ({
  page,
}) => {
  // docs/TODO.md: "When the new session draft view is open in the sidebar both the
  // new session and the previously focused session are highlighted at once. Only the
  // 'new session' should be highlighted."
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // The greeting session is focused (and highlighted) before any draft opens.
  const focusedRow = sidebar.locator("button.row", {
    hasText: "Wire up the WebSocket bridge",
  });
  await expect(focusedRow).toHaveClass(/\bactive\b/);

  await newDraftIn(page, "pantoken");
  const draftRow = group(page, "pantoken").getByTestId("draft-row");
  await expect(draftRow).toHaveClass(/\bactive\b/);

  // The previously focused row is still visible, but plain — not highlighted...
  await expect(focusedRow).toBeVisible();
  await expect(focusedRow).not.toHaveClass(/\bactive\b/);
  // ...so the draft is the ONLY highlighted row in the whole sidebar.
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);

  // Canceling the draft (back to the focused session) restores its highlight.
  // Drafts are canceled with Escape (the old hero Cancel button was removed when
  // the new-session composer was centered — see mvzutsvywlkt).
  await draftBox(page).focus();
  await page.keyboard.press("Escape");
  await expect(focusedRow).toHaveClass(/\bactive\b/);
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);
});

test("the × discards a draft", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("discard me");

  const pantokenDraft = group(page, "pantoken").getByTestId("draft-row");
  await expect(pantokenDraft).toBeVisible();

  // Hover reveals the × on desktop; clicking it drops the draft entirely.
  await pantokenDraft.hover();
  await page
    .getByRole("button", { name: "Discard this new-session draft" })
    .click();
  await expect(page.getByTestId("draft-row")).toHaveCount(0);
});

test("retargeting a draft moves its row to the new project — no ghost left behind", async ({
  page,
}) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("moving");

  // Stash the draft under the pantoken key by navigating away, then reopen it. This is the
  // case migration must handle: a retarget now has a stale stashed copy to clean up.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await group(page, "pantoken").getByTestId("draft-row").click();

  // Retarget via the project menu → "New project…" → dir picker.
  await page.getByTestId("draft-project-control").click();
  await page.getByTestId("project-menu").getByText("New project…").click();
  await page.mouse.move(0, 0);
  await expect(page.getByTestId("dir-picker")).toBeVisible();
  const picker = page.getByTestId("dir-picker");
  const input = picker.getByLabel("Project directory path");
  await input.fill("/Users/timo/src/scratch/");
  await expect(picker.getByTestId("use-current-directory")).toBeVisible();
  await picker.getByTestId("use-current-directory").click();

  // The row now lives under scratch, and pantoken has no leftover ghost row.
  await expect(group(page, "scratch").getByTestId("draft-row")).toBeVisible();
  await expect(group(page, "pantoken").getByTestId("draft-row")).toHaveCount(0);

  // Re-stash under the new key and confirm only scratch persists (the pantoken key was
  // migrated away, not duplicated).
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(group(page, "scratch").getByTestId("draft-row")).toBeVisible();
  await expect(group(page, "pantoken").getByTestId("draft-row")).toHaveCount(0);
});

test("a draft hides when its project group is collapsed", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("hide me");

  const pantoken = group(page, "pantoken");
  await expect(pantoken.getByTestId("draft-row")).toBeVisible();

  // Collapsing the group hides the draft with it (the draft <li> rides the group's <ul>).
  await pantoken.locator(".group-toggle").click();
  await expect(pantoken.getByTestId("draft-row")).toBeHidden();
});

test("a draft row shows a Draft label and no plus marker", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");

  const draft = group(page, "pantoken").getByTestId("draft-row");
  await expect(draft).toBeVisible();
  // The visible "Draft" text label is present.
  await expect(draft.locator(".draft-label")).toHaveText("Draft");
  // The old leading + draft marker is gone.
  await expect(draft.locator(".draft-marker")).toHaveCount(0);
});

test("Draft label remains visible after navigating away from an active draft", async ({
  page,
}) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("persist label");

  const draft = group(page, "pantoken").getByTestId("draft-row");
  await expect(draft.locator(".draft-label")).toHaveText("Draft");

  // Navigate to an existing session — the draft row is now inactive but the
  // Draft label is still visible.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(draft).toBeVisible();
  await expect(draft).not.toHaveClass(/\bactive\b/);
  await expect(draft.locator(".draft-label")).toHaveText("Draft");
});

test("a nested draft shows Draft with no location tag", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");

  const draft = group(page, "pantoken").getByTestId("draft-row");
  await expect(draft).toBeVisible();
  // Nested drafts (showTag === false) show only "Draft", no location tag.
  await expect(draft.locator(".draft-label")).toHaveText("Draft");
  await expect(draft.locator(".tag")).toHaveCount(0);
});

test("a top-level draft shows its location tag and Draft separated by a middot", async ({
  page,
}) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("retarget to top-level");

  // Stash the draft, then retarget it to a non-project cwd so it floats at the
  // top level (showTag === true) instead of nesting under a project group.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await group(page, "pantoken").getByTestId("draft-row").click();

  await page.getByTestId("draft-project-control").click();
  await page.getByTestId("project-menu").getByText("New project…").click();
  await page.mouse.move(0, 0);
  const picker = page.getByTestId("dir-picker");
  const input = picker.getByLabel("Project directory path");
  await input.fill("/Users/timo/src/elsewhere/");
  await picker.getByTestId("use-current-directory").click();

  // The top-level draft row shows both the location tag and "Draft".
  const topDraft = page
    .getByTestId("sidebar")
    .locator(".draft-top")
    .getByTestId("draft-row");
  await expect(topDraft).toBeVisible();
  await expect(topDraft.locator(".tag")).toHaveText("elsewhere");
  await expect(topDraft.locator(".draft-label")).toHaveText("Draft");
  await expect(topDraft.locator(".meta-sep")).toHaveText("·");
});

test("hovering a draft row does not shift its height", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");

  const draft = group(page, "pantoken").getByTestId("draft-row");
  await expect(draft).toBeVisible();

  const before = await draft.boundingBox();
  expect(before).not.toBeNull();

  await draft.hover();
  // The discard × overlays the meta (which fades) without changing the row height.
  const after = await draft.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.height).toBe(before!.height);
});
