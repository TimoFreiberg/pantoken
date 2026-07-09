import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Control (not Meta) — CI runs Chromium on Linux and the handler accepts metaKey||ctrlKey.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const box = (page: Page) => page.getByTestId("transcript-search");
const count = (page: Page) => page.getByTestId("find-count");
const findInput = (page: Page) =>
  box(page).getByPlaceholder("Find in transcript");

function currentHighlighted(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      CSS.highlights.has("pantoken-find-current"),
  );
}

test("⌘F opens the find box and focuses it", async ({ page }) => {
  await expect(box(page)).toBeHidden();
  await page.keyboard.press("Control+f");
  await expect(box(page)).toBeVisible();
  await expect(findInput(page)).toBeFocused();
});

test("find-as-you-type counts matches, highlights, and steps next/prev", async ({
  page,
}) => {
  await page.keyboard.press("Control+f");
  // "health" appears in the user prompt and the final assistant line (≥2 visible).
  await findInput(page).fill("health");

  await expect(count(page)).toHaveText(/^1\/\d+$/);
  await expect.poll(() => currentHighlighted(page)).toBe(true);

  // Next / prev cycle the current index (Enter == next button).
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(count(page)).toHaveText(/^2\/\d+$/);
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(count(page)).toHaveText(/^1\/\d+$/);

  // Enter also advances.
  await findInput(page).press("Enter");
  await expect(count(page)).toHaveText(/^2\/\d+$/);
});

test("a query with no matches shows 0/0 and no current highlight", async ({
  page,
}) => {
  await page.keyboard.press("Control+f");
  await findInput(page).fill("zzznotinthetranscript");
  await expect(count(page)).toHaveText("0/0");
  await expect.poll(() => currentHighlighted(page)).toBe(false);
});

test("Esc closes the box and clears highlights", async ({ page }) => {
  await page.keyboard.press("Control+f");
  await findInput(page).fill("health");
  await expect(count(page)).toHaveText(/^1\/\d+$/);
  await expect.poll(() => currentHighlighted(page)).toBe(true);

  await findInput(page).press("Escape");
  await expect(box(page)).toBeHidden();
  await expect.poll(() => currentHighlighted(page)).toBe(false);
});

test("⌘F does nothing while drafting a new session (no transcript)", async ({
  page,
}) => {
  await page.keyboard.press("Control+n"); // open a new-session draft
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  await page.keyboard.press("Control+f");
  await expect(box(page)).toBeHidden();
});

// Regression: runSearch TreeWalks only rendered DOM, so a match that lives entirely
// inside a collapsed "Worked for Ns" run was invisible to it (the lane is unmounted via
// {#if workShown(...)}, not just hidden). The "Cold-restore regression check" fixture
// (restored_session_seed in mock_driver.rs) always opens with its one work run collapsed
// by default (see reload-session.e2e.ts) — exactly the shape this needs.
test("search finds a match inside a collapsed work run and expands it", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByText("Cold-restore regression check").click();
  await expect(page.locator("header .title")).toContainText(
    "Cold-restore regression check",
  );

  // Precondition: the run is genuinely collapsed on open, same as reload-session.e2e.ts.
  const toggle = page.getByTestId("work-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("work-body")).toHaveCount(0);

  // "current implementation" only appears in the collapsed run's narration ("Sure —
  // let me check the current implementation first.") — never in the turn-final visible
  // response ("...now backs off exponentially...").
  await page.keyboard.press("Control+f");
  await findInput(page).fill("current implementation");
  await expect(count(page)).toHaveText(/^1\/\d+$/);

  // Finding it must actually expand the run, not just see through it while it stays
  // visually collapsed.
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("work-body")).toBeVisible();
});
