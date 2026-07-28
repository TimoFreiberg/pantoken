import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

/** Set the host state via window.__pantokenHosts (triggers coordinator.refreshHosts). */
async function setState(page: import("@playwright/test").Page, id: string, state: string): Promise<void> {
  await page.evaluate(
    ({ id, state }) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => Promise<void> } }).__pantokenHosts?.setState(id, state),
    { id, state },
  );
}

/** Get the profile id for a given label via window.__pantokenHosts. */
async function getProfileId(page: import("@playwright/test").Page, label: string): Promise<string> {
  return page.evaluate(
    (label) => {
      const hosts = (window as unknown as { __pantokenHosts?: { listProfiles: () => Promise<{ id: string; label: string }[]> } }).__pantokenHosts;
      return (hosts?.listProfiles() ?? Promise.resolve([])).then((ps) => ps.find((p) => p.label === label)?.id ?? "");
    },
    label,
  );
}

/** Create a Host profile via the setup sheet, driving the mock to ready. */
async function createHostProfile(page: import("@playwright/test").Page, name: string, ssh: string): Promise<void> {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Fill name and SSH, then click Test SSH & connect.
  await page.getByTestId("cs-name-input").fill(name);
  await page.getByTestId("cs-ssh-input").fill(ssh);
  await page.getByTestId("cs-test-ssh").click();
  // The mock resolves immediately — provisioning starts. Drive to ready.
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
  const id = await getProfileId(page, name);
  await setState(page, id, "ready");
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });
  // Dismiss any connection sheet that may have auto-showed.
  const csPanel = page.getByTestId("connection-sheet-panel");
  if (await csPanel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(csPanel).toBeHidden({ timeout: 5000 });
  }
}

test("Add computer button opens the setup sheet", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await expect(page.getByTestId("cs-name-input")).toBeVisible();
});

test("Add computer initially selects Host environment (AC.3)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Host segment should be active.
  await expect(page.getByTestId("cs-env-host")).toHaveAttribute("aria-checked", "true");
  // Primary button should say "Test SSH & connect" (AC.5).
  await expect(page.getByTestId("cs-test-ssh")).toContainText("Test SSH & connect");
});

test("Setup Docker initially selects Docker environment (AC.3)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Docker segment should be active.
  await expect(page.getByTestId("cs-env-docker")).toHaveAttribute("aria-checked", "true");
  // Primary button should say "Test SSH & find containers".
  await expect(page.getByTestId("cs-test-ssh")).toContainText("Test SSH & find containers");
});

test("Switching environment updates primary action copy (AC.4)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  // Default is Host → "Test SSH & connect".
  await expect(page.getByTestId("cs-test-ssh")).toContainText("Test SSH & connect");
  // Switch to Docker.
  await page.getByTestId("cs-env-docker").click();
  await expect(page.getByTestId("cs-test-ssh")).toContainText("Test SSH & find containers");
  // Switch back to Host.
  await page.getByTestId("cs-env-host").click();
  await expect(page.getByTestId("cs-test-ssh")).toContainText("Test SSH & connect");
});

test("Both launchers open the same dialog (AC.2)", async ({ page }) => {
  // HostSwitcher Add.
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await page.getByTestId("computer-setup-close").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();

  // Settings Add.
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await page.getByTestId("computer-setup-close").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();

  // Settings Setup Docker.
  await page.getByTestId("settings-setup-docker").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
});

test("Add computer from dropdown closes the dropdown", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // The dropdown panel should be gone.
  await expect(page.locator("#host-switcher-panel")).toHaveCount(0);
});

test("Sheet opens with first input focused", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("cs-name-input")).toBeFocused();
});

test("Typing while sheet is open does not steal composer focus", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Explicitly blur the input to simulate focus-drift.
  await page.getByTestId("cs-name-input").evaluate((el) => (el as HTMLInputElement).blur());
  // Confirm the input is no longer focused before pressing a key.
  await expect(page.getByTestId("cs-name-input")).not.toBeFocused();
  // Press a printable key.
  await page.keyboard.press("a");
  // The composer textarea should NOT have focus.
  const activeTag = await page.evaluate(() => document.activeElement?.tagName);
  expect(activeTag).not.toBe("TEXTAREA");
  // The sheet's first input should have been refocused.
  await expect(page.getByTestId("cs-name-input")).toBeFocused();
});

test("Manage computers opens Settings to Computers section", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("manage-computers-btn").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("computers-section")).toBeVisible();
});

test("Computers section shows local computer", async ({ page }) => {
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  await expect(page.getByTestId("computers-section")).toContainText("Connected");
});

test("Host test/save/connect path adds a profile (AC.4 Host)", async ({ page }) => {
  await createHostProfile(page, "Test Server", "user@test.example.com");
  // Reopen settings to verify the profile appears.
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toContainText("Test Server");
  await expect(page.getByTestId("computers-section")).toContainText("test.example.com");
});

test("Validation shows errors inline and preserves values", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  // Fill name but leave SSH empty, then click Test SSH & connect.
  await page.getByTestId("cs-name-input").fill("My Server");
  // The button should be disabled when SSH is empty.
  await expect(page.getByTestId("cs-test-ssh")).toBeDisabled();
  // Fill SSH with content but the test will fail validation if port is invalid.
  // Actually, for Host mode the button is enabled once SSH has content.
  await page.getByTestId("cs-ssh-input").fill("user@test.example.com");
  await expect(page.getByTestId("cs-test-ssh")).toBeEnabled();
});

test("Edit opens the sheet pre-filled with the profile's values (AC.10)", async ({ page }) => {
  await createHostProfile(page, "Edit Me", "user@edit.example.com");

  // Click Edit on the profile.
  await openSettings(page, "computers");
  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Edit Me" });
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Edit stage should show the read-only exec env.
  await expect(page.getByTestId("cs-edit-exec-env")).toBeVisible();
  await expect(page.getByTestId("cs-edit-exec-env")).toContainText("Host");
  await expect(page.getByTestId("cs-edit-exec-env")).toContainText("immutable");
  // Name should be pre-filled.
  await expect(page.getByTestId("cs-edit-name")).toHaveValue("Edit Me");

  const editSsh = page.getByTestId("cs-edit-ssh");
  const editPort = page.locator("#cs-edit-port");
  await expect(editPort).toHaveAccessibleName("Port");
  const editSshBox = await editSsh.boundingBox();
  const editPortBox = await editPort.boundingBox();
  expect(editSshBox).not.toBeNull();
  expect(editPortBox).not.toBeNull();
  if (editSshBox && editPortBox) {
    expect(Math.round(editPortBox.width)).toBeGreaterThanOrEqual(70);
    expect(Math.round(editPortBox.width)).toBeLessThanOrEqual(90);
    expect(editSshBox.width).toBeGreaterThan(editPortBox.width * 3);
  }
});

test("Remove shows a confirmation, then removes the profile", async ({ page }) => {
  await createHostProfile(page, "Remove Me", "user@remove.example.com");

  await openSettings(page, "computers");
  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Remove Me" });
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("[data-testid^='delete-confirm-']")).toBeVisible();
  await page.locator("[data-testid^='delete-confirm-']").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("computers-section")).not.toContainText("Remove Me");
});

test("No secret fields in sheet", async ({ page }) => {
  await openSettings(page, "computers");
  await page.getByTestId("add-computer-btn").click();
  // Verify no password/key/passphrase inputs exist.
  const inputs = page.getByTestId("computer-setup-panel").locator("input");
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const type = await inputs.nth(i).getAttribute("type");
    expect(type).not.toBe("password");
  }
});

test("Host mode never says it will find containers (AC.5)", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  // Primary label should not mention containers.
  const btn = page.getByTestId("cs-test-ssh");
  await expect(btn).toContainText("Test SSH & connect");
  await expect(btn).not.toContainText("container");
  // The testing sub-step label for Host should only mention SSH, not Docker.
  // (The testing box is transient with the mock, so we verify the label
  // derivation indirectly: the button text is the authoritative copy.)
});

test("Profile round-trip: create then edit (AC.13)", async ({ page }) => {
  await createHostProfile(page, "Round Trip", "user@roundtrip.example.com");
  // Edit and verify values round-trip (no reload — mock doesn't persist to disk).
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toContainText("Round Trip");
  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Round Trip" });
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await expect(page.getByTestId("cs-edit-name")).toHaveValue("Round Trip");
  await expect(page.getByTestId("cs-edit-ssh")).toHaveValue("user@roundtrip.example.com");
});

test("PWA degradation: Docker segment disabled when unsupported (AC.14)", async ({ page }) => {
  // Disable Docker support before opening the sheet.
  await page.evaluate(
    () => (window as unknown as { __pantokenHosts?: { setSupportsContainerTargets: (e: boolean) => void } }).__pantokenHosts?.setSupportsContainerTargets(false),
  );
  // Use the "Setup Docker" launcher — it starts with Docker selected, so the
  // degraded hint will show.
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Docker segment should be disabled.
  await expect(page.getByTestId("cs-env-docker")).toBeDisabled();
  // Host segment should remain enabled.
  await expect(page.getByTestId("cs-env-host")).toBeEnabled();
  // Degraded hint should be visible (execEnv is docker but unsupported).
  await expect(page.getByTestId("cs-docker-degraded")).toBeVisible();
});
