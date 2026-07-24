import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// Mobile project — these tests run at 375px (Pixel 7) viewport.
// Playwright's mobile project config handles the viewport; we just use the helpers.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** Set pending risks for the next Docker profile created via window.__pantokenHosts. */
async function setPendingRisksForNextDocker(page: import("@playwright/test").Page, risks: unknown[]): Promise<void> {
  await page.evaluate(
    (rs) => (window as unknown as { __pantokenHosts?: { setPendingRisksForNextDocker: (rs: unknown[]) => void } }).__pantokenHosts?.setPendingRisksForNextDocker(rs),
    risks,
  );
}

const EPHEMERAL_RISK = {
  id: "ephemeral-1",
  kind: "ephemeralData",
  fingerprint: "ephemeral:/home/dev/.local/share/pantoken:Ephemeral · container writable layer",
  title: "Ephemeral Pantoken root",
  explanation: "Pantoken data will be lost when this container is replaced.",
  consequences: "Sessions and runtime files will be lost.",
  continueLabel: "Accept risk",
};

test("Setup sheet is full-screen on phone", async ({ page }) => {
  // Open the sidebar (phone: it's a drawer).
  await page.getByTestId("sidebar-open").click();
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  const panel = page.getByTestId("container-setup-panel");
  await expect(panel).toBeVisible();
  // Full-screen: no scrim on phone.
  await expect(page.locator(".scrim")).toBeHidden();
  // Panel should fill the viewport.
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(370);
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(700);
  }
});

test("SSH test and container picker work at 375px", async ({ page }) => {
  await page.getByTestId("sidebar-open").click();
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();

  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  // Container rows should be visible and tappable.
  await expect(page.getByTestId("cs-container-work-api-dev")).toBeVisible();
});

test("Risk panel renders on phone", async ({ page }) => {
  await setPendingRisksForNextDocker(page, [EPHEMERAL_RISK]);

  await page.getByTestId("sidebar-open").click();
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();

  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-risk-ephemeralData")).toBeVisible();
  // Both buttons should be visible (ephemeral-only variant).
  await expect(page.getByTestId("cs-choose-path")).toBeVisible();
  await expect(page.getByTestId("cs-accept-risks")).toBeVisible();
});

test("Back button navigates from container picker to SSH fields", async ({ page }) => {
  await page.getByTestId("sidebar-open").click();
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Phone back button should be visible.
  const backButton = page.locator(".mobile-back");
  await expect(backButton).toBeVisible();
  await backButton.click();

  // Should go back to SSH fields.
  await expect(page.getByTestId("cs-ssh-input")).toBeVisible();
});

test("Interactive elements meet 44px touch target minimum", async ({ page }) => {
  await page.getByTestId("sidebar-open").click();
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  // The close button should be at least 44px.
  const closeBtn = page.getByTestId("container-setup-close");
  const box = await closeBtn.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
  }

  // The test SSH button should be at least 44px.
  const testBtn = page.getByTestId("cs-test-ssh");
  const testBox = await testBtn.boundingBox();
  expect(testBox).not.toBeNull();
  if (testBox) {
    expect(Math.round(testBox.height)).toBeGreaterThanOrEqual(44);
  }
});
