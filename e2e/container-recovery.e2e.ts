import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

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

/** Drive a container replacement via window.__pantokenHosts. */
async function driveReplacement(page: import("@playwright/test").Page, id: string): Promise<void> {
  await page.evaluate(
    (id) => (window as unknown as { __pantokenHosts?: { driveReplacement: (id: string) => void } }).__pantokenHosts?.driveReplacement(id),
    id,
  );
}

/** Set the host state via window.__pantokenHosts. */
async function setState(page: import("@playwright/test").Page, id: string, state: string): Promise<void> {
  await page.evaluate(
    ({ id, state }) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => void } }).__pantokenHosts?.setState(id, state),
    { id, state },
  );
}

async function createAndProvisionDockerProfile(page: import("@playwright/test").Page): Promise<string> {
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
  return id;
}

test("Container replacement shows reconnecting status", async ({ page }) => {
  const id = await createAndProvisionDockerProfile(page);

  // Drive a replacement — host goes to reconnecting internally,
  // but driveReplacement doesn't trigger coordinator.refreshHosts.
  // Follow with setState to force the coordinator to pick up the change.
  await driveReplacement(page, id);
  await setState(page, id, "reconnecting");

  // Dismiss any connection sheet that may have auto-showed.
  const csPanel = page.getByTestId("connection-sheet-panel");
  if (await csPanel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(csPanel).toBeHidden({ timeout: 5000 });
  }

  // The host switcher should show reconnecting status.
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  const option = page.locator(".host-option").filter({ hasText: "Work API Dev" });
  await expect(option).toContainText("Reconnecting", { timeout: 10000 });
});

test("Failed connection after replacement shows failure UI", async ({ page }) => {
  const id = await createAndProvisionDockerProfile(page);

  // Drive replacement then failure.
  await driveReplacement(page, id);
  await setState(page, id, "failed");

  // The connection sheet should show failure UI.
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("failure-section")).toBeVisible();
});
