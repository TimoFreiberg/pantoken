import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

/** Drive provisioning phase via window.__pantokenHosts. */
async function driveProvisioningPhase(page: import("@playwright/test").Page, id: string, phase: number): Promise<void> {
  await page.evaluate(
    ({ id, phase }) => (window as unknown as { __pantokenHosts?: { driveProvisioningPhase: (id: string, phase: number) => void } }).__pantokenHosts?.driveProvisioningPhase(id, phase),
    { id, phase },
  );
}

/** Set the host state via window.__pantokenHosts. */
async function setState(page: import("@playwright/test").Page, id: string, state: string): Promise<void> {
  await page.evaluate(
    ({ id, state }) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => void } }).__pantokenHosts?.setState(id, state),
    { id, state },
  );
}

async function createDockerProfile(page: import("@playwright/test").Page): Promise<string> {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();
  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });

  // Get the saved profile id from the provider's profile list.
  const id = await page.evaluate(() => {
    const hosts = (window as unknown as { __pantokenHosts?: { listProfiles: () => Promise<{ id: string; label: string }[]> } }).__pantokenHosts;
    return hosts?.listProfiles().then((ps) => ps.find((p) => p.label === "Work API Dev")?.id ?? "");
  });
  // Drive to ready — setState triggers coordinator.refreshHosts so the
  // provisioning watcher $effect sees the state transition.
  await setState(page, id, "ready");
  await expect(page.getByTestId("container-setup-panel")).toBeHidden({ timeout: 10000 });
  // The ConnectionSheet may auto-show during provisioning. Dismiss it if present
  // so it doesn't intercept clicks when we later open Settings.
  const csPanel = page.getByTestId("connection-sheet-panel");
  if (await csPanel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(csPanel).toBeHidden({ timeout: 5000 });
  }
  return id;
}

test("Docker profile appears in Computers section with Docker tag", async ({ page }) => {
  await createDockerProfile(page);
  await openSettings(page, "computers");

  const section = page.getByTestId("computers-section");
  await expect(section).toContainText("Work API Dev");
  // Close Settings so its scrim doesn't intercept the host switcher click.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-panel")).toBeHidden();
  // The host switcher shows ▣ for Docker targets.
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await expect(page.locator(".host-option").filter({ hasText: "Work API Dev" })).toContainText("▣");
});

test("Setup button on Docker profile opens edit dialog", async ({ page }) => {
  await createDockerProfile(page);
  await openSettings(page, "computers");

  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Work API Dev" });
  await row.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByTestId("container-setup-panel")).toBeVisible();
  // Edit stage should show the read-only exec env.
  await expect(page.getByTestId("cs-edit-exec-env")).toBeVisible();
  await expect(page.getByTestId("cs-edit-exec-env")).toContainText("Docker container");
});

test("Edit dialog shows reconnect now / later buttons", async ({ page }) => {
  await createDockerProfile(page);
  await openSettings(page, "computers");

  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Work API Dev" });
  await row.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByTestId("container-setup-panel")).toBeVisible();

  await expect(page.getByTestId("cs-reconnect-now")).toBeVisible();
  await expect(page.getByTestId("cs-reconnect-later")).toBeVisible();
});

test("Settings has Setup Docker container button", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("settings-setup-docker").click();
  await expect(page.getByTestId("container-setup-panel")).toBeVisible();
  await expect(page.getByTestId("cs-ssh-input")).toBeVisible();
});

test("Container not running state shows in Computers section", async ({ page }) => {
  // Create a profile via exact-name fallback (no provisioning).
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();
  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-exact-name-link").click();
  await page.getByTestId("cs-exact-input").fill("stopped-container");
  await page.getByTestId("cs-save-later").click();
  await expect(page.getByTestId("container-setup-panel")).toBeHidden({ timeout: 10000 });

  // Check it appears in Settings as disconnected.
  await openSettings(page, "computers");
  const section = page.getByTestId("computers-section");
  await expect(section).toContainText("Stopped Container");
});
