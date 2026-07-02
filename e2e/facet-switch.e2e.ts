import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The facet picker (in the composer toolbar) switches the active facet. Clicking
// it sends a setFacet wire message → the mock emits a sessionUpdated snapshot
// with the new facet → foldEvent propagates → the badge updates. The badge shows
// the ACTUAL current facet ("Execute"/"Plan"), not the old affordance label.
// ⌘⇧C (Cmd+Shift+C) cycles through all available facets — it fires even when
// the composer is focused (unlike the old Shift+Tab, which the browser consumed
// for reverse-focus traversal in form fields).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("clicking the facet badge opens a picker and switching works", async ({
  page,
}) => {
  // The badge shows the actual facet: "Execute" in the default (execute) state.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Execute");

  // Click the badge → opens the dropdown picker. Click "Plan" to switch.
  await badge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toHaveText("Plan");
  await expect(badge).toHaveClass(/plan/);

  // Click the badge → opens the picker again. Click "Execute" to switch back.
  await badge.click();
  await page.getByRole("option", { name: "Execute" }).click();
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

test("Cmd+Shift+C cycles facets even when the composer is focused", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Focus the composer textarea — the key fix: the hotkey must fire even here.
  await page.getByPlaceholder("Message pilot…").focus();

  // Cmd+Shift+C → switch to plan mode.
  await page.keyboard.press("Meta+Shift+C");
  await expect(badge).toHaveText("Plan");
});

test("Cmd+Shift+C cycles through all facets and wraps", async ({ page }) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // The mock returns two facets: ["execute", "plan"]. Pressing the hotkey
  // twice (N = facet count) should cycle execute → plan → execute (wrap).
  await page.keyboard.press("Meta+Shift+C");
  await expect(badge).toHaveText("Plan");

  await page.keyboard.press("Meta+Shift+C");
  await expect(badge).toHaveText("Execute");
});

test("Shift+Tab does not toggle facets", async ({ page }) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Shift+Tab should perform normal browser reverse-focus traversal — it must
  // NOT cycle facets anymore. Press it and confirm the badge is unchanged.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
});
