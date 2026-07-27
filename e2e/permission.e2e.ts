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

test("permission badge width is stable when cycling through all modes", async ({
  page,
}) => {
  const badge = page.getByTestId("permission-badge");
  await expect(badge).toContainText("Standard");

  // Measure the badge width in the initial (Standard) state.
  const box0 = await badge.boundingBox();
  expect(box0).not.toBeNull();
  const initialWidth = box0!.width;

  // Cycle through all 4 modes via ⌘⇧P. After each cycle, measure the badge
  // width — it must stay constant (the .permission-badge .badge-text min-width
  // reserves space for the longest label, "Autonomous").
  await page.keyboard.press("Control+Shift+P"); // Standard → Bypass
  await expect(badge).toContainText("Bypass");
  await expect(badge).not.toContainText("Bypass+");
  const box1 = await badge.boundingBox();
  expect(box1).not.toBeNull();
  expect(box1!.width).toBe(initialWidth);

  await page.keyboard.press("Control+Shift+P"); // Bypass → Bypass+
  await expect(badge).toContainText("Bypass+");
  const box2 = await badge.boundingBox();
  expect(box2).not.toBeNull();
  expect(box2!.width).toBe(initialWidth);

  await page.keyboard.press("Control+Shift+P"); // Bypass+ → Autonomous
  await expect(badge).toContainText("Autonomous");
  const box3 = await badge.boundingBox();
  expect(box3).not.toBeNull();
  expect(box3!.width).toBe(initialWidth);

  await page.keyboard.press("Control+Shift+P"); // Autonomous → Standard (wrap)
  await expect(badge).toContainText("Standard");
  const box4 = await badge.boundingBox();
  expect(box4).not.toBeNull();
  expect(box4!.width).toBe(initialWidth);
});

test("permission badge round-trips all 4 modes via picker", async ({
  page,
}) => {
  const badge = page.getByTestId("permission-badge");
  await expect(badge).toContainText("Standard");

  // Open the panel and verify all 4 options are present.
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("option", { name: /^Standard/ })).toBeVisible();
  await expect(
    panel.getByRole("option", { name: /^Bypass[^+]/ }),
  ).toBeVisible();
  await expect(panel.getByRole("option", { name: /^Bypass\+/ })).toBeVisible();
  await expect(
    panel.getByRole("option", { name: /^Autonomous/ }),
  ).toBeVisible();

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
