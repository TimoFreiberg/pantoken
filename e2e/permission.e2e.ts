import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

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

  // The badge updates to the new mode and exposes its non-standard state class.
  await expect(badge).toContainText("Bypass");
  await expect(badge).not.toContainText("Bypass+");
  await expect(badge).toHaveClass(/nonstandard/);
  // Info notice appears in the transcript.
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Permission monitor set to Bypass",
  );
});

test("permission badge sits on the status row left", async ({ page }) => {
  const left = page.locator("[data-testid='composer-status-row'] .status-left");
  await expect(left.getByTestId("permission-badge")).toBeVisible();
  await expect(
    page.getByTestId("composer-status-right").getByTestId("permission-badge"),
  ).toHaveCount(0);
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
  // Issue #54: closing the permission menu (Enter pick) returns focus to the
  // composer textarea.
  await expect(page.getByPlaceholder("Message pantoken…")).toBeFocused();

  // Reopen, Esc closes without changing.
  await badge.click();
  await expect(panel).toBeVisible();
  await panel.press("Escape");
  await expect(panel).toBeHidden();
  await expect(badge).toContainText("Bypass");
  // Issue #54: closing the permission menu (Esc) returns focus to the composer.
  await expect(page.getByPlaceholder("Message pantoken…")).toBeFocused();
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
