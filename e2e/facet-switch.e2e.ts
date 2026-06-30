import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The facet toggle (now in the composer toolbar) switches the active facet
// (execute ↔ plan). Clicking it sends a setFacet wire message → the mock emits a
// sessionUpdated snapshot with the new facet → foldEvent propagates → the badge
// updates. The badge shows the ACTUAL current facet ("Execute"/"Plan"), not the
// old affordance label. Shift+Tab (the TUI convention) also toggles, but only when
// no form field is focused (preserving browser focus-traversal).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("clicking the facet toggle switches to plan mode and back", async ({
  page,
}) => {
  // The badge shows the actual facet: "Execute" in the default (execute) state.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Execute");

  // Click → switch to plan mode. The badge turns into the accent-tinted "Plan" pill.
  await badge.click();
  await expect(badge).toHaveText("Plan");
  await expect(badge).toHaveClass(/plan/);

  // Click again → switch back to execute. The badge reverts to the subtle "Execute" chip.
  await badge.click();
  await expect(badge).toHaveText("Execute");
  await expect(badge).not.toHaveClass(/plan/);
});

test("the facet badge sits in the composer toolbar, left of the model badge", async ({
  page,
}) => {
  // AC.2 — the badge lives in the composer footer toolbar (.toolbar-right),
  // immediately left of the model/effort badges.
  const order = await page
    .locator(".toolbar-right [data-testid]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order.indexOf("facet-badge")).toBeLessThan(order.indexOf("model-badge"));
});

test("Shift+Tab toggles facets when no form field is focused", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Click somewhere in the page body to ensure no form field is focused.
  await page.locator("body").click();

  // Shift+Tab → switch to plan mode.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Plan");

  // Shift+Tab again → switch back to execute.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
});

test("Shift+Tab does NOT toggle when the composer is focused", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Focus the composer textarea.
  await page.getByPlaceholder("Message pilot…").focus();

  // Shift+Tab while the composer is focused should NOT toggle the facet — it
  // should reverse-tab through form fields instead (preserving browser behavior).
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
});
