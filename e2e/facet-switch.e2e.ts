import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The facet toggle in the StatusHeader switches the active facet (execute ↔ plan).
// Clicking it sends a setFacet wire message → the mock emits a sessionUpdated
// snapshot with the new facet → foldEvent propagates → the badge updates.
// Shift+Tab (the TUI convention) also toggles, but only when no form field is
// focused (preserving browser focus-traversal).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("clicking the facet toggle switches to plan mode and back", async ({
  page,
}) => {
  // The facet badge starts in "dormant" mode (execute) — shows a subtle "Plan" toggle.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Plan");

  // Click → switch to plan mode. The badge turns into the accent-tinted "Plan mode" pill.
  await badge.click();
  await expect(badge).toHaveText("Plan mode");
  await expect(badge).toHaveClass(/facet-badge/);

  // Click again → switch back to execute. The badge reverts to the dormant "Plan" toggle.
  await badge.click();
  await expect(badge).toHaveText("Plan");
  await expect(badge).toHaveClass(/facet-dormant/);
});

test("Shift+Tab toggles facets when no form field is focused", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Plan");

  // Click somewhere in the page body to ensure no form field is focused.
  await page.locator("body").click();

  // Shift+Tab → switch to plan mode.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Plan mode");

  // Shift+Tab again → switch back to execute.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Plan");
});

test("Shift+Tab does NOT toggle when the composer is focused", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Plan");

  // Focus the composer textarea.
  await page.getByPlaceholder("Message pilot…").focus();

  // Shift+Tab while the composer is focused should NOT toggle the facet — it
  // should reverse-tab through form fields instead (preserving browser behavior).
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Plan");
});
