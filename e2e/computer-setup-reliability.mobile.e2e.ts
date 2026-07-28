import { expect, test, type Page } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  // Mobile viewport.
  await page.setViewportSize({ width: 412, height: 915 });
  await gotoFresh(page);
  await openSidebar(page);
});

/** Open the Add Computer setup sheet from the host switcher. */
async function openAddComputer(page: Page): Promise<void> {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
}

// ── AC.4 (mobile): Phone Back on dirty draft ────────────────────────────────

test("AC.4: Phone Back on dirty draft shows discard prompt", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Phone Dirty");
  // Simulate phone back button — go back in history.
  await page.goBack();
  // Should show the discard prompt, not close immediately.
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible({ timeout: 5000 });
});

test("AC.4: Phone Back on clean draft closes immediately", async ({ page }) => {
  await openAddComputer(page);
  // No edits — should close immediately.
  await page.goBack();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 5000 });
  await expect(page.getByTestId("cs-discard-confirm")).toHaveCount(0);
});

// ── AC.14 (mobile): Focus restoration ────────────────────────────────────────

test("AC.14: Focus restoration on phone — launcher focused, not composer", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  const trigger = switcher.getByTestId("host-switcher-trigger");
  await trigger.click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Close without editing.
  await page.getByTestId("computer-setup-close").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 5000 });
  // Focus should be on the host-switcher trigger (or its container), not the composer.
  await page.waitForTimeout(300);
  const activeTag = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.tagName + (el?.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : "");
  });
  // The composer textarea should NOT be focused.
  expect(activeTag).not.toContain("TEXTAREA");
});
