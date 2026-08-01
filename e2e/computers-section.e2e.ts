import { expect, test, type Page } from "@playwright/test";
import type { TestSshResult } from "../client/src/lib/hosts/types.js";
import { gotoFresh, openSettings, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Open the Add Computer setup sheet from the host switcher. */
async function openAddComputer(page: Page): Promise<void> {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
}

/** Open the Add Computer setup sheet from Settings. */
async function openAddComputerFromSettings(page: Page): Promise<void> {
  await openSettings(page, "computers");
  // Use the settings panel's add-computer-btn (scoped to avoid matching the host-switcher's).
  await page.getByTestId("settings-panel").getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
}

/** Close the setup sheet via the header close button. */
async function closeSheet(page: Page): Promise<void> {
  await page.getByTestId("computer-setup-close").click();
}

/** Set a provider behavior via window.__pantokenHosts. */
async function setNextBehavior(
  page: Page,
  method: string,
  behavior: { delay?: number; reject?: unknown; result?: TestSshResult } | null,
): Promise<void> {
  await page.evaluate(
    ({ method, behavior }) => {
      const hosts = (window as unknown as Record<string, unknown>).__pantokenHosts as
        | Record<string, (b: unknown) => void>
        | undefined;
      hosts?.[method]?.(behavior);
    },
    { method, behavior },
  );
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

/** Count profiles. */
async function countProfiles(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hosts = (window as unknown as { __pantokenHosts?: { listProfiles: () => Promise<{ id: string }[]> } }).__pantokenHosts;
    return (hosts?.listProfiles() ?? Promise.resolve([])).then((ps) => ps.length);
  });
}

/** Create a Host profile via the setup sheet, driving the mock to ready. */
async function createHostProfile(page: Page, name: string, ssh: string): Promise<void> {
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

// ── Flows ────────────────────────────────────────────────────────────────────

// Opening the Add Computer sheet: host-switcher launcher, default env, focus
test("Setup sheet open and initial state from host switcher", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await expect(page.getByTestId("cs-name-input")).toBeVisible();
  // Host segment should be active.
  await expect(page.getByTestId("cs-env-host")).toHaveAttribute("aria-checked", "true");
  // Primary button should say "Test SSH & connect" (AC.5).
  await expect(page.getByTestId("cs-test-ssh")).toContainText("Test SSH & connect");
  // Panel still visible after env checks.
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Name input is focused on open (AC.10).
  await page.waitForTimeout(200);
  const activeId = await page.evaluate(() => document.activeElement?.id);
  expect(activeId).toBe("cs-name");
});

// Manage computers opens Settings to Computers section
test("Manage computers opens Settings to Computers section", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("manage-computers-btn").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("computers-section")).toBeVisible();
});

// Computers section shows the local computer
test("Computers section shows local computer", async ({ page }) => {
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toBeVisible();
  await expect(page.getByTestId("computers-section")).toContainText("Connected");
});

// Host mode never says it will find containers (AC.5)
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

// PWA degradation: Docker segment disabled when unsupported (AC.14)
test("PWA degradation: Docker segment disabled when unsupported (AC.14)", async ({ page }) => {
  // Disable Docker support before opening the sheet.
  await page.evaluate(
    () => (window as unknown as { __pantokenHosts?: { setSupportsContainerTargets: (e: boolean) => void } }).__pantokenHosts?.setSupportsContainerTargets(false),
  );
  // Open via the single add launcher — Docker is disabled when unsupported, so
  // the sheet can no longer start with it selected.
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Docker segment should be disabled; Host remains enabled.
  await expect(page.getByTestId("cs-env-docker")).toBeDisabled();
  await expect(page.getByTestId("cs-env-host")).toBeEnabled();
  // The degradation explanation lives in the segment's title tooltip.
  await expect(page.getByTestId("cs-env-docker")).toHaveAttribute("title", /Docker targets require the Pantoken desktop app/);
});

// Host switcher dropdown shows a single add entry labeled Add remote host
test("Host switcher dropdown shows a single add entry labeled Add remote host", async ({ page }) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await expect(page.locator("#host-switcher-panel")).toBeVisible();
  // Exactly one add entry, renamed from "Add computer" → "Add remote host".
  await expect(switcher.getByTestId("add-computer-btn")).toHaveText("Add remote host");
  // The old "Setup Docker container" launcher is gone.
  await expect(switcher.getByTestId("host-switcher-setup-docker")).toHaveCount(0);
  // "Manage computers" remains.
  await expect(switcher.getByTestId("manage-computers-btn")).toBeVisible();
});

// Host profile creation and listing (AC.4 Host)
test("Host profile creation and listing", async ({ page }) => {
  await createHostProfile(page, "Test Server", "user@test.example.com");
  // Reopen settings to verify the profile appears.
  await openSettings(page, "computers");
  await expect(page.getByTestId("computers-section")).toContainText("Test Server");
  await expect(page.getByTestId("computers-section")).toContainText("test.example.com");
});

// Editing a profile: edit sheet pre-fill, exec env, and field geometry
test("Edit a profile: pre-fill, exec env, port field sizing (AC.10)", async ({ page }) => {
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

// Removing a profile: confirmation then removal
test("Remove a profile with confirmation", async ({ page }) => {
  await createHostProfile(page, "Remove Me", "user@remove.example.com");

  await openSettings(page, "computers");
  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Remove Me" });
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("[data-testid^='delete-confirm-']")).toBeVisible();
  await page.locator("[data-testid^='delete-confirm-']").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("computers-section")).not.toContainText("Remove Me");
});

// Round-trip: create then edit (AC.13)
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

// Validation: button enable/disable and inline errors, no secret fields
test("Validation: button state and no secret fields", async ({ page }) => {
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

  // Verify no password/key/passphrase inputs exist.
  const inputs = page.getByTestId("computer-setup-panel").locator("input");
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const type = await inputs.nth(i).getAttribute("type");
    expect(type).not.toBe("password");
  }
});

// Focus behavior while the sheet is open
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

// Focus trap: Tab wraps within the panel (AC.12)
test("Focus trap: Tab from last focusable wraps to first", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").focus();
  // Tab multiple times to reach the last focusable, then one more.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
  }
  // After wrapping, focus should be within the panel.
  const activeInPanel = await page.evaluate(() => {
    const panel = document.querySelector("[data-testid='computer-setup-panel']");
    return panel?.contains(document.activeElement);
  });
  expect(activeInPanel).toBe(true);
});

// Global hotkeys are inert while setup is open (AC.13)
test("Global hotkeys inert: .shell has inert attribute while setup open", async ({ page }) => {
  await openAddComputer(page);
  const isInert = await page.evaluate(() => {
    const shell = document.querySelector(".shell");
    return shell?.hasAttribute("inert");
  });
  expect(isInert).toBe(true);
});

// Discard-prompt flows: clean close, dirty close, keep editing, discard (AC.2–AC.6)
test("Discard prompt: clean close, dirty close, keep editing, discard", async ({ page }) => {
  // AC.2: Clean close — no discard prompt when closing without editing.
  await openAddComputer(page);
  await closeSheet(page);
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
  await expect(page.getByTestId("cs-discard-confirm")).toHaveCount(0);

  // AC.3: Editing port triggers discard prompt on close.
  await openAddComputer(page);
  await page.getByTestId("cs-port-input").fill("2222");
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();

  // AC.5: Keep editing preserves values and focus.
  await page.getByTestId("cs-discard-keep").click();
  await expect(page.getByTestId("cs-discard-confirm")).toHaveCount(0);
  // Values preserved.
  await expect(page.getByTestId("cs-name-input")).toHaveValue("");
  await expect(page.getByTestId("cs-port-input")).toHaveValue("2222");
  // Panel still visible.
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();

  // AC.6: Discard clears draft and closes.
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
  await page.getByTestId("cs-discard-discard").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
  // Reopen — should be blank.
  await openAddComputer(page);
  await expect(page.getByTestId("cs-name-input")).toHaveValue("");
});

// Discard prompt via Escape on dirty draft (AC.4)
test("Discard prompt: Escape on dirty draft shows discard prompt", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Escape Test");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
});

// Draft persistence to localStorage and clear-on-save (AC.7, AC.8)
test("Draft persistence: localStorage and clear-on-save", async ({ page }) => {
  // AC.7: Draft persists to localStorage.
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Persisted Name");
  await page.getByTestId("cs-ssh-input").fill("user@persist.test");
  // Wait for debounce to persist.
  await page.waitForTimeout(1000);
  // Verify localStorage has the draft.
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem("pantoken.computerSetupDraft");
    return raw ? JSON.parse(raw) : null;
  });
  expect(stored).not.toBeNull();
  expect(stored.name).toBe("Persisted Name");
  expect(stored.sshDestination).toBe("user@persist.test");

  // AC.8: Saving a profile clears the persisted draft.
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
  const id = await getProfileId(page, "Persisted Name");
  await page.evaluate(
    ({ id }) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => Promise<void> } }).__pantokenHosts?.setState(id, "ready"),
    { id },
  );
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });
  // Dismiss connection sheet if visible.
  const csPanel = page.getByTestId("connection-sheet-panel");
  if (await csPanel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
  }
  // localStorage should be cleared.
  const hasDraft = await page.evaluate(() => localStorage.getItem("pantoken.computerSetupDraft") !== null);
  expect(hasDraft).toBe(false);
  // Reopen — blank draft.
  await openAddComputer(page);
  await expect(page.getByTestId("cs-name-input")).toHaveValue("");
});

// Failed save preserves all form fields (AC.9)
test("Failed save preserves all form fields (AC.9)", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Fail Server");
  await page.getByTestId("cs-ssh-input").fill("user@fail.test");
  await page.getByTestId("cs-port-input").fill("2222");
  // Set addProfile to reject.
  await setNextBehavior(page, "setNextAddProfileBehavior", { reject: new Error("Network error") });
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-form-error")).toBeVisible({ timeout: 10000 });
  // All fields preserved.
  await expect(page.getByTestId("cs-name-input")).toHaveValue("Fail Server");
  await expect(page.getByTestId("cs-ssh-input")).toHaveValue("user@fail.test");
  await expect(page.getByTestId("cs-port-input")).toHaveValue("2222");
});

// Double-submit prevention: Test SSH button disabled while pending (AC.15)
test("Double-submit prevention: Test SSH disabled while pending (AC.15)", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-ssh-input").fill("user@host.test");
  // Set a delay on testSsh so the button stays disabled.
  await setNextBehavior(page, "setNextTestSshBehavior", { delay: 2000 });
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  // The testing box should be visible.
  await expect(page.getByTestId("cs-testing")).toBeVisible({ timeout: 5000 });
  // The button should not be present (it's replaced by the testing box).
  await expect(page.getByTestId("cs-test-ssh")).toHaveCount(0);
});

// addProfile rejection produces visible error UI (AC.16)
test("addProfile rejection shows error UI (AC.16)", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-ssh-input").fill("user@reject.test");
  await setNextBehavior(page, "setNextAddProfileBehavior", { reject: new Error("Connection refused") });
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-form-error")).toBeVisible({ timeout: 10000 });
});

// Save-success/connect-failure is partial success, no duplicate (AC.19)
test("Save succeeds, connect fails → partial success, no duplicate (AC.19)", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Partial Server");
  await page.getByTestId("cs-ssh-input").fill("user@partial.test");
  // addProfile succeeds, connectHost fails.
  await setNextBehavior(page, "setNextConnectHostBehavior", { reject: new Error("SSH unreachable") });
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  // Should show provisioning failure (coordinator catches the provider error
  // and returns { ok: false } — the sheet shows "saved but not connected").
  await expect(page.getByTestId("cs-prov-failure")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-prov-failure")).toContainText("saved but not connected");
  // Profile count should be 1 (not 2) — addProfile succeeded once.
  const count = await countProfiles(page);
  expect(count).toBe(1);
  // Retry connect button should exist.
  await expect(page.getByTestId("cs-prov-retry")).toBeVisible();
});

// Background ConnectionSheet deferred while setup is open (AC.20)
test("ConnectionSheet does not appear over setup (AC.20)", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Setup Active");
  // While setup is open, drive another host to connecting state.
  await page.evaluate(
    () => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => Promise<void> } }).__pantokenHosts?.setState("dev-remote", "connecting"),
  );
  // ConnectionSheet should NOT be visible.
  await expect(page.getByTestId("connection-sheet-panel")).toHaveCount(0);
  // Now close the setup (it's dirty, so discard).
  await closeSheet(page);
  await page.getByTestId("cs-discard-discard").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
  // After setup closes, ConnectionSheet may appear for the pending host.
  // (It may or may not appear depending on host state transitions, but the
  // key assertion is that it did NOT appear while setup was open.)
});

// ── #142: Real SSH errors surface in the setup sheet ────────────────────────

test("#142: SSH test rejection surfaces the real error, not the degradation message", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-ssh-input").fill("user@unreachable.test");
  await setNextBehavior(page, "setNextTestSshBehavior", {
    reject: new Error("SSH connection failed: Connection refused"),
  });
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-error")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-ssh-error")).toContainText("Connection refused");
  await expect(page.getByTestId("cs-ssh-error")).not.toContainText("Container commands");
});

test("#142: sshOk false with stderr detail shows the real ssh message", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-ssh-input").fill("user@key.test");
  await setNextBehavior(page, "setNextTestSshBehavior", {
    result: {
      sshOk: false,
      dockerPermission: "unknown",
      containers: [],
      sshErrorDetail: "Permission denied (publickey).",
    },
  });
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-error")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-ssh-error")).toContainText("Permission denied (publickey).");
  await expect(page.getByTestId("cs-ssh-error")).not.toContainText("Check the SSH destination");
});
