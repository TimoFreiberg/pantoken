import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The permission-monitor badge (composer toolbar) shows the daemon's live
// per-session permission mode (standard/bypass/bypass_plus/autonomous) and lets
// the user switch it. Mirrors the facet badge: clicking the chip opens a 4-item
// panel; selecting emits a setPermissionMonitor wire → mock emits a
// sessionUpdated snapshot carrying the new permissionMonitor → foldEvent
// propagates → badge updates.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("permission badge shows Standard by default and switches mode", async ({
  page,
}) => {
  const badge = page.getByTestId("permission-badge");
  await expect(badge).toBeVisible();
  // Seeded "standard" by the mock's snapshot() base.
  await expect(badge).toContainText("Standard");

  // Open the panel + pick Bypass (not Bypass+).
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await expect(panel).toBeVisible();
  await panel.getByRole("option", { name: /^Bypass[^+]/ }).click();

  // The badge updates to the new mode (accent-tinted, non-standard).
  await expect(badge).toContainText("Bypass");
  await expect(badge).not.toContainText("Bypass+");
  await expect(badge).toHaveClass(/nonstandard/);
});

test("permission badge sits in the composer toolbar, left of the facet badge", async ({
  page,
}) => {
  // AC.3 — the badge lives in the composer footer toolbar (.toolbar-right),
  // left of the facet badge (row reads permission → facet → model → effort).
  const order = await page
    .locator(".toolbar-right [data-testid]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order.indexOf("permission-badge")).toBeLessThan(
    order.indexOf("facet-badge"),
  );
});

test("permission panel is keyboard-navigable (Esc closes, arrows move, Enter picks)", async ({
  page,
}) => {
  const badge = page.getByTestId("permission-badge");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await expect(panel).toBeVisible();

  // Arrow down once (standard → bypass), Enter picks.
  await panel.press("ArrowDown");
  await panel.press("Enter");
  await expect(badge).toContainText("Bypass");
  await expect(badge).not.toContainText("Bypass+");

  // Reopen, Esc closes without changing.
  await badge.click();
  await expect(panel).toBeVisible();
  await panel.press("Escape");
  await expect(panel).toBeHidden();
  await expect(badge).toContainText("Bypass");
});

test("⌘⇧P cycles permission mode", async ({ page }) => {
  const badge = page.getByTestId("permission-badge");
  await expect(badge).toContainText("Standard");

  // ⌘⇧P cycles: Standard → Bypass.
  await page.keyboard.press("Control+Shift+P");
  await expect(badge).toContainText("Bypass");
  await expect(badge).not.toContainText("Bypass+");

  // Again: Bypass → Bypass+.
  await page.keyboard.press("Control+Shift+P");
  await expect(badge).toContainText("Bypass+");

  // Again: Bypass+ → Autonomous.
  await page.keyboard.press("Control+Shift+P");
  await expect(badge).toContainText("Autonomous");

  // Again: Autonomous → Standard (wraps).
  await page.keyboard.press("Control+Shift+P");
  await expect(badge).toContainText("Standard");
});

test("permission badge round-trips all 4 modes via picker", async ({ page }) => {
  const badge = page.getByTestId("permission-badge");
  await expect(badge).toContainText("Standard");

  // Open the panel and verify all 4 options are present.
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("option", { name: /^Standard/ })).toBeVisible();
  await expect(panel.getByRole("option", { name: /^Bypass[^+]/ })).toBeVisible();
  await expect(panel.getByRole("option", { name: /^Bypass\+/ })).toBeVisible();
  await expect(panel.getByRole("option", { name: /^Autonomous/ })).toBeVisible();

  // Pick Bypass+ and verify the badge updates.
  await panel.getByRole("option", { name: /^Bypass\+/ }).click();
  await expect(badge).toContainText("Bypass+");
  await expect(badge).toHaveClass(/nonstandard/);

  // Re-open and pick Autonomous — not Bypass or Bypass+.
  await badge.click();
  await panel.getByRole("option", { name: /^Autonomous/ }).click();
  await expect(badge).toContainText("Autonomous");

  // Re-open and return to Standard.
  await badge.click();
  await panel.getByRole("option", { name: /^Standard/ }).click();
  await expect(badge).toContainText("Standard");
});

// --- Draft-mode test (AC.3) ---
// While a new-session draft is open, clicking the permission badge must set the
// DRAFT's permission-monitor, not the previously focused session's.

test("clicking the permission badge in the draft view sets the draft's permission, not the old session's", async ({
  page,
}) => {
  await openSidebar(page);
  // The greeting session is focused — its permission badge reads "Standard".
  const liveBadge = page.getByTestId("permission-badge");
  await expect(liveBadge).toContainText("Standard");

  // Open a new-session draft.
  await page.getByTestId("sidebar").getByText("New session…").click();
  await expect(page.getByTestId("new-session")).toBeVisible();

  // Open the panel + pick Bypass — this should write to the draft.
  const draftBadge = page.getByTestId("permission-badge");
  await draftBadge.click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await expect(panel).toBeVisible();
  await panel.getByRole("option", { name: /^Bypass[^+]/ }).click();
  await expect(draftBadge).toContainText("Bypass");

  // Navigate back to the old session — its permission is unchanged ("Standard").
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .locator(".row", { hasText: "Wire up the WebSocket bridge" })
    .click();
  await expect(page.getByTestId("permission-badge")).toContainText("Standard");
});
