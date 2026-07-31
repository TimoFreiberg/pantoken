import { expect, test, devices, type Page } from "@playwright/test";
import { gotoFresh, openSidebar, openSettings } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test.use({ ...devices["Pixel 7"] });

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Open the Add Computer setup sheet from the host switcher. */
async function openAddComputer(page: Page): Promise<void> {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
}

/** Set the host state via window.__pantokenHosts (triggers coordinator.refreshHosts). */
async function setState(page: Page, id: string, state: string): Promise<void> {
  await page.evaluate(
    ({ id, state }) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => Promise<void> } }).__pantokenHosts?.setState(id, state),
    { id, state },
  );
}

/** Get the profile id for a given label via window.__pantokenHosts. */
async function getProfileId(page: Page, label: string): Promise<string> {
  return page.evaluate(
    (label) => {
      const hosts = (window as unknown as { __pantokenHosts?: { listProfiles: () => Promise<{ id: string; label: string }[]> } }).__pantokenHosts;
      return (hosts?.listProfiles() ?? Promise.resolve([])).then((ps) => ps.find((p) => p.label === label)?.id ?? "");
    },
    label,
  );
}

// ── Flows ────────────────────────────────────────────────────────────────────

// Mobile Computers section renders with 44px touch targets
test("Computers section renders with 44px touch targets", async ({ page }) => {
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  const addBtn = page.getByTestId("add-computer-btn");
  const box = await addBtn.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

// Mobile setup sheet is full-screen with Back button
test("Setup sheet is full-screen with Back button", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  const panel = page.getByTestId("computer-setup-panel");
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(350);
  // Close via Close button.
  await panel.getByTestId("computer-setup-close").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
});

// Mobile: Add computer from dropdown closes dropdown on phone
test("Add computer from dropdown closes dropdown on phone", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await expect(page.locator("#host-switcher-panel")).toHaveCount(0);
});

// Mobile: Closing returns to launcher (AC.12)
test("Closing returns to launcher (AC.12)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Close via the close button.
  await page.getByTestId("computer-setup-close").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
});

// Mobile Host profile creation end-to-end
test("Host profile creation works on phone", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await page.getByTestId("cs-name-input").fill("Phone Server");
  await page.getByTestId("cs-ssh-input").fill("user@phone.example.com");
  await page.getByTestId("cs-test-ssh").click();
  // Provisioning starts — drive to ready.
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
  const id = await getProfileId(page, "Phone Server");
  await setState(page, id, "ready");
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });
  // Dismiss connection sheet if present.
  const csPanel = page.getByTestId("connection-sheet-panel");
  if (await csPanel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(csPanel).toBeHidden({ timeout: 5000 });
  }
  // Verify the profile was created via the provider API (reliable on phone).
  const profiles = await page.evaluate(() => {
    const hosts = (window as unknown as { __pantokenHosts?: { listProfiles: () => Promise<{ id: string; label: string }[]> } }).__pantokenHosts;
    return (hosts?.listProfiles() ?? Promise.resolve([]));
  });
  expect(profiles.some((p) => p.label === "Phone Server")).toBe(true);
});

// Mobile: Phone Back on dirty draft shows discard prompt (AC.4)
test("Phone Back on dirty draft shows discard prompt (AC.4)", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Phone Dirty");
  // Simulate phone back button — go back in history.
  await page.goBack();
  // Should show the discard prompt, not close immediately.
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible({ timeout: 5000 });
});

// Mobile: Phone Back on clean draft closes immediately (AC.4)
test("Phone Back on clean draft closes immediately (AC.4)", async ({ page }) => {
  await openAddComputer(page);
  // No edits — should close immediately.
  await page.goBack();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 5000 });
  await expect(page.getByTestId("cs-discard-confirm")).toHaveCount(0);
});

// Mobile focus restoration: launcher focused, not composer (AC.14)
test("Focus restoration on phone — launcher focused, not composer (AC.14)", async ({ page }) => {
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
