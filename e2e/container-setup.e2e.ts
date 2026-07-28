import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

/** Set the container picker via window.__pantokenHosts. */
async function setContainerPicker(page: import("@playwright/test").Page, containers: unknown[]): Promise<void> {
  await page.evaluate(
    (cs) => (window as unknown as { __pantokenHosts?: { setContainerPicker: (id: string, cs: unknown[]) => void } }).__pantokenHosts?.setContainerPicker("__default__", cs),
    containers,
  );
}

/** Drive provisioning phase via window.__pantokenHosts. */
async function driveProvisioningPhase(page: import("@playwright/test").Page, id: string, phase: number): Promise<void> {
  await page.evaluate(
    ({ id, phase }) => (window as unknown as { __pantokenHosts?: { driveProvisioningPhase: (id: string, phase: number) => void } }).__pantokenHosts?.driveProvisioningPhase(id, phase),
    { id, phase },
  );
}

/** Set the host state (triggers coordinator.refreshHosts) via window.__pantokenHosts. */
async function setState(page: import("@playwright/test").Page, id: string, state: string): Promise<void> {
  await page.evaluate(
    ({ id, state }) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => Promise<void> } }).__pantokenHosts?.setState(id, state),
    { id, state },
  );
}

test("Setup Docker button opens the container setup sheet", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await expect(page.getByTestId("cs-ssh-input")).toBeVisible();
});

test("SSH test reveals container picker", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();

  // The dev provider resolves immediately, so the testing state is transient.
  // Container picker appears after test resolves.
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-ssh-summary")).toContainText("SSH connected");
});

test("Selecting a container and clicking Use starts provisioning", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Select the first container.
  await page.getByTestId("cs-container-work-api-dev").click();
  await expect(page.getByTestId("cs-use-container")).toBeVisible();

  // Click Use this container — starts provisioning.
  await page.getByTestId("cs-use-container").click();
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
});

test("Provisioning reaches ready and closes the sheet", async ({ page }) => {
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
    return (hosts?.listProfiles() ?? Promise.resolve([])).then((ps) => ps.find((p) => p.label === "Work API Dev")?.id ?? "");
  });
  // Drive to ready — setState triggers coordinator.refreshHosts so the
  // provisioning watcher $effect sees the state transition.
  await setState(page, id, "ready");

  // Sheet should close on success.
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });
});

test("Exact-name fallback saves without provisioning", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Click "Enter exact container name instead".
  await page.getByTestId("cs-exact-name-link").click();
  await expect(page.getByTestId("cs-exact-input")).toBeVisible();
  await expect(page.getByTestId("cs-not-running-warning")).toBeVisible();

  // Type a name and save.
  await page.getByTestId("cs-exact-input").fill("my-stopped-container");
  await page.getByTestId("cs-save-later").click();

  // Sheet should close.
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });
});

test("Customize target shows inspection details", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  await page.getByTestId("cs-container-work-api-dev").click();
  // Customize disclosure should appear.
  await page.getByTestId("cs-customize-toggle").click();
  await expect(page.getByTestId("cs-customize")).toBeVisible();
  // User input and root input should be visible.
  await expect(page.getByTestId("cs-user-input")).toBeVisible();
  await expect(page.getByTestId("cs-root-input")).toBeVisible();
  // Backing line should show persistent volume.
  await expect(page.getByTestId("cs-backing")).toContainText("Persistent");
});

test("SSH fields remain visible after Docker discovery (AC.7)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // SSH input should still be visible and editable in the container picker stage.
  await expect(page.getByTestId("cs-ssh-input")).toBeVisible();
  await expect(page.getByTestId("cs-name-input")).toBeVisible();
});

test("Editing SSH after discovery invalidates stale results (AC.8)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Edit the SSH destination — should invalidate the picker.
  await page.getByTestId("cs-ssh-input").fill("user@changed.example.com");

  // The picker summary should be gone, and we should be back at connection fields.
  await expect(page.getByTestId("cs-ssh-summary")).toBeHidden();
  // The test button should be visible again (connection fields stage).
  await expect(page.getByTestId("cs-test-ssh")).toBeVisible();
});

test("Name suggestion appears when selecting a container (AC.9)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Select a container — name should be auto-suggested.
  await page.getByTestId("cs-container-work-api-dev").click();
  await expect(page.getByTestId("cs-name-input")).toHaveValue("Work API Dev");
});

test("User-entered name is never overwritten by suggestion (AC.9)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  await page.getByTestId("cs-name-input").fill("My Custom Name");
  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Select a container — the user-entered name should be preserved.
  await page.getByTestId("cs-container-work-api-dev").click();
  await expect(page.getByTestId("cs-name-input")).toHaveValue("My Custom Name");
});

test("SSH row inputs have correct relative widths at desktop", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  const sshInput = page.getByTestId("cs-ssh-input");
  const portInput = page.getByTestId("cs-port-input");

  const sshBox = await sshInput.boundingBox();
  const portBox = await portInput.boundingBox();
  expect(sshBox).not.toBeNull();
  expect(portBox).not.toBeNull();
  if (sshBox && portBox) {
    // Port should be approximately 80px (allow for borders/padding variance).
    expect(Math.round(portBox.width)).toBeGreaterThanOrEqual(70);
    expect(Math.round(portBox.width)).toBeLessThanOrEqual(90);
    // SSH input should be substantially wider than port.
    expect(sshBox.width).toBeGreaterThan(portBox.width * 3);
  }
});

test("Port input has accessible label", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  // The port input's accessible name should be "Port".
  const portInput = page.getByTestId("cs-port-input");
  await expect(portInput).toHaveAccessibleName("Port");
});

test("Full-width action buttons keep intrinsic height at desktop", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();

  // The test SSH button should have an intrinsic height, not fill vertical space.
  const testBtn = page.getByTestId("cs-test-ssh");
  const box = await testBtn.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    // Intrinsic height: should be well under 100px (padding-based, ~44-50px).
    expect(Math.round(box.height)).toBeLessThan(100);
  }
});
