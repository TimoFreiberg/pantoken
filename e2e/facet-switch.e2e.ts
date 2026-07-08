import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The facet picker (in the composer toolbar) switches the active facet. Clicking
// it sends a setFacet wire message → the mock emits a sessionUpdated snapshot
// with the new facet → foldEvent propagates → the badge updates. The badge shows
// the ACTUAL current facet ("Execute"/"Plan"), not the old affordance label.
// ⌘⇧C (Cmd+Shift+C) opens the dropdown picker — it fires even when the composer
// is focused. Number keys (1-9) quick-select inside the open dropdown.

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
  expect(order.indexOf("facet-badge")).toBeLessThan(
    order.indexOf("model-badge"),
  );
});

test("Cmd+Shift+C opens the facet dropdown even when the composer is focused", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Focus the composer textarea — the key fix: the hotkey must fire even here.
  await page.getByPlaceholder("Message pantoken…").focus();

  // Cmd+Shift+C → opens the dropdown picker (does NOT cycle).
  await page.keyboard.press("Meta+Shift+C");

  // The panel should be visible with the facet options.
  const panel = page.locator(".panel[role='listbox']");
  await expect(panel).toBeVisible();

  // The options should list the three facets with number prefixes.
  await expect(panel.getByRole("option", { name: /Plan/ })).toBeVisible();
  await expect(panel.getByRole("option", { name: /Research/ })).toBeVisible();

  // Escape closes the panel without changing the facet.
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Execute");
});

test("number key quick-selects a facet from the open dropdown", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Open the dropdown via the hotkey.
  await page.keyboard.press("Meta+Shift+C");
  const panel = page.locator(".panel[role='listbox']");
  await expect(panel).toBeVisible();

  // Press "2" → selects the 2nd facet (plan). Panel closes, badge updates.
  await page.keyboard.press("2");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Plan");

  // Open again, press "1" → back to execute.
  await page.keyboard.press("Meta+Shift+C");
  await expect(panel).toBeVisible();
  await page.keyboard.press("1");
  await expect(badge).toHaveText("Execute");

  // Open again, press "3" → research.
  await page.keyboard.press("Meta+Shift+C");
  await expect(panel).toBeVisible();
  await page.keyboard.press("3");
  await expect(badge).toHaveText("Research");
});

test("Shift+Tab does not toggle facets", async ({ page }) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Shift+Tab should perform normal browser reverse-focus traversal — it must
  // NOT cycle facets anymore. Press it and confirm the badge is unchanged.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
});

// --- Draft-mode tests (AC.1, AC.2) ---
// While a new-session draft is open, store.session still points at the previously
// focused session. The facet badge + Shift+Tab must read/write the DRAFT, not the
// old session. These tests guard against the regression where the draft view mutated
// the focused session instead.

test("⌘⇧C in the new-session draft opens the dropdown for the DRAFT's facet, not the session's", async ({
  page,
}) => {
  await openSidebar(page);
  // The greeting session is focused — its facet badge reads "Execute".
  const liveBadge = page.getByTestId("facet-badge");
  await expect(liveBadge).toHaveText("Execute");

  // Open a new-session draft.
  await page.getByTestId("sidebar").getByText("New session…").click();
  await expect(page.getByTestId("new-session")).toBeVisible();
  // The draft's facet badge also reads "Execute" (the draft default).
  const draftBadge = page.getByTestId("facet-badge");
  await expect(draftBadge).toHaveText("Execute");

  // ⌘⇧C opens the dropdown for the draft's facet. Press "2" to select Plan.
  await page.keyboard.press("Meta+Shift+C");
  const panel = page.locator(".panel[role='listbox']");
  await expect(panel).toBeVisible();
  await page.keyboard.press("2");
  await expect(draftBadge).toHaveText("Plan");

  // Navigate back to the old session — its facet must be unchanged ("Execute").
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");
});

test("clicking the facet badge in the draft view toggles the draft, not the old session", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("New session…").click();
  await expect(page.getByTestId("new-session")).toBeVisible();

  const draftBadge = page.getByTestId("facet-badge");
  await expect(draftBadge).toHaveText("Execute");

  // Open the picker and select Plan — this writes to the draft.
  await draftBadge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(draftBadge).toHaveText("Plan");

  // Navigate back to the old session — its facet is unchanged.
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");
});

// Helper used by draft-mode tests: click a sidebar row by title.
function row(page: Page, title: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: title });
}
