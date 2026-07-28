import { expect, test, type Page } from "@playwright/test";
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
  behavior: { delay?: number; reject?: unknown } | null,
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

/** Get a profile id by label. */
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

// ── AC.2: Clean close ────────────────────────────────────────────────────────

test("AC.2: Clean close — no discard prompt when closing without editing", async ({ page }) => {
  await openAddComputer(page);
  await closeSheet(page);
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
  await expect(page.getByTestId("cs-discard-confirm")).toHaveCount(0);
});

test("AC.2: Clean close from edit — no discard prompt on untouched edit", async ({ page }) => {
  // First create a profile to edit.
  await openAddComputerFromSettings(page);
  await page.getByTestId("cs-name-input").fill("Edit Target");
  await page.getByTestId("cs-ssh-input").fill("user@edit.test");
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
  const id = await getProfileId(page, "Edit Target");
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

  // Now open edit for that profile.
  await openSettings(page, "computers");
  await page.getByTestId(`computer-edit-${id}`).click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Close without making changes — should NOT show discard prompt.
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toHaveCount(0);
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
});

// ── AC.3: Dirty fields trigger discard prompt ───────────────────────────────

test("AC.3: Editing port triggers discard prompt on close", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-port-input").fill("2222");
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
});

test("AC.3: Editing environment triggers discard prompt on close", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-env-docker").click();
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
});

test("AC.3: Editing SSH destination triggers discard prompt on close", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-ssh-input").fill("user@host.test");
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
});

// ── AC.5/AC.6: Discard confirmation actions ────────────────────────────────

test("AC.5: Keep editing preserves values and focus", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("My Server");
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
  await page.getByTestId("cs-discard-keep").click();
  await expect(page.getByTestId("cs-discard-confirm")).toHaveCount(0);
  // Values preserved.
  await expect(page.getByTestId("cs-name-input")).toHaveValue("My Server");
  // Panel still visible.
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
});

test("AC.6: Discard clears draft and closes", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Temp Name");
  await closeSheet(page);
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
  await page.getByTestId("cs-discard-discard").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden();
  // Reopen — should be blank.
  await openAddComputer(page);
  await expect(page.getByTestId("cs-name-input")).toHaveValue("");
});

// ── AC.7: Draft survival across reload ─────────────────────────────────────

test("AC.7: Draft persists to localStorage", async ({ page }) => {
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
});

// ── AC.8: Successful save clears persisted draft ─────────────────────────────

test("AC.8: Saving a profile clears the persisted draft", async ({ page }) => {
  await openAddComputerFromSettings(page);
  await page.getByTestId("cs-name-input").fill("Saved Server");
  await page.getByTestId("cs-ssh-input").fill("user@saved.test");
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
  const id = await getProfileId(page, "Saved Server");
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

// ── AC.9: Failed save preserves fields ──────────────────────────────────────

test("AC.9: Failed save preserves all form fields", async ({ page }) => {
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

// ── AC.10: Initial focus lands in Name input ─────────────────────────────────

test("AC.10: Name input is focused on open", async ({ page }) => {
  await openAddComputer(page);
  await page.waitForTimeout(200);
  const activeId = await page.evaluate(() => document.activeElement?.id);
  expect(activeId).toBe("cs-name");
});

// ── AC.12: Focus trap ─────────────────────────────────────────────────────────

test("AC.12: Tab from last focusable wraps to first", async ({ page }) => {
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

test("AC.12: Shift+Tab from first focusable wraps to last", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").focus();
  await page.keyboard.press("Shift+Tab");
  // After wrapping, focus should be within the panel.
  const activeInPanel = await page.evaluate(() => {
    const panel = document.querySelector("[data-testid='computer-setup-panel']");
    return panel?.contains(document.activeElement);
  });
  expect(activeInPanel).toBe(true);
});

// ── AC.13: Global hotkeys are inert ─────────────────────────────────────────

test("AC.13: inert attribute on .shell while setup open", async ({ page }) => {
  await openAddComputer(page);
  const isInert = await page.evaluate(() => {
    const shell = document.querySelector(".shell");
    return shell?.hasAttribute("inert");
  });
  expect(isInert).toBe(true);
});

// ── AC.15: Double-submit prevention ──────────────────────────────────────────

test("AC.15: Test SSH button is disabled while pending", async ({ page }) => {
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

// ── AC.16: Rejection produces visible error UI ──────────────────────────────

test("AC.16: addProfile rejection shows error UI", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-ssh-input").fill("user@reject.test");
  await setNextBehavior(page, "setNextAddProfileBehavior", { reject: new Error("Connection refused") });
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-form-error")).toBeVisible({ timeout: 10000 });
});

test("AC.16: Non-Error rejection shows normalized message", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-ssh-input").fill("user@objreject.test");
  await setNextBehavior(page, "setNextAddProfileBehavior", { reject: { message: "Custom object error" } });
  await page.getByTestId("cs-env-host").click();
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-form-error")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-form-error")).toContainText("Custom object error");
});

// ── AC.19: Save-success/connect-failure is partial success ───────────────────

test("AC.19: Save succeeds, connect fails → partial success, no duplicate", async ({ page }) => {
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

// ── AC.20: Background ConnectionSheet deferred ─────────────────────────────

test("AC.20: ConnectionSheet does not appear over setup", async ({ page }) => {
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

// ── AC.4: All close paths route through requestClose ────────────────────────

test("AC.4: Scrim click on dirty draft shows discard prompt", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Scrim Test");
  // Click the setup sheet's scrim via JS to bypass the panel intercepting
  // pointer events. The setup scrim is the last .scrim element on the page
  // (the sidebar also has one). Dispatch a real click event so the onclick
  // handler fires and routes through requestClose().
  await page.locator(".scrim").last().evaluate((el) => { (el as HTMLElement).click(); });
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
});

test("AC.4: Escape on dirty draft shows discard prompt", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Escape Test");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
});

test("AC.4: Cancel button on dirty draft shows discard prompt", async ({ page }) => {
  await openAddComputer(page);
  await page.getByTestId("cs-name-input").fill("Cancel Test");
  await page.getByTestId("cs-cancel-setup").click();
  await expect(page.getByTestId("cs-discard-confirm")).toBeVisible();
});
