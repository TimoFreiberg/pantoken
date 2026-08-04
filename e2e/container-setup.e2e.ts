import { expect, test } from "@playwright/test";
import { gotoFresh, openDockerSetupFromSwitcher, openSettings, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

// ---------------------------------------------------------------------------
// Helpers — drive the mock host coordinator via window.__pantokenHosts
// ---------------------------------------------------------------------------

/** Set the host state (triggers coordinator.refreshHosts) via window.__pantokenHosts. */
async function setState(page: import("@playwright/test").Page, id: string, state: string): Promise<void> {
  await page.evaluate(
    ({ id, state }) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => Promise<void> } }).__pantokenHosts?.setState(id, state),
    { id, state },
  );
}

/** Drive a container replacement via window.__pantokenHosts. */
async function driveReplacement(page: import("@playwright/test").Page, id: string): Promise<void> {
  await page.evaluate(
    (id) => (window as unknown as { __pantokenHosts?: { driveReplacement: (id: string) => void } }).__pantokenHosts?.driveReplacement(id),
    id,
  );
}

/** Set pending risks for the next Docker profile created via window.__pantokenHosts. */
async function setPendingRisksForNextDocker(page: import("@playwright/test").Page, risks: unknown[]): Promise<void> {
  await page.evaluate(
    (rs) => (window as unknown as { __pantokenHosts?: { setPendingRisksForNextDocker: (rs: unknown[]) => void } }).__pantokenHosts?.setPendingRisksForNextDocker(rs),
    risks,
  );
}

/** Set a custom inspection for a container name via window.__pantokenHosts. */
async function setInspection(page: import("@playwright/test").Page, containerName: string, inspection: unknown): Promise<void> {
  await page.evaluate(
    ({ containerName, inspection }) => (window as unknown as { __pantokenHosts?: { setInspection: (name: string, insp: unknown) => void } }).__pantokenHosts?.setInspection(containerName, inspection),
    { containerName, inspection },
  );
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

/** Open the host switcher, choose "Setup Docker", fill SSH, test, select the
 *  work-api-dev container, and click "Use this container". */
async function openSetupAndSelectContainer(page: import("@playwright/test").Page): Promise<void> {
  await openDockerSetupFromSwitcher(page);
  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();
}

/** Create a Docker profile, drive it to ready, and return the profile id.
 *  Dismisses the auto-showing connection sheet so it won't intercept later clicks. */
async function createDockerProfile(page: import("@playwright/test").Page): Promise<string> {
  await openDockerSetupFromSwitcher(page);
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
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });
  // The ConnectionSheet may auto-show during provisioning. Dismiss it if present
  // so it doesn't intercept clicks when we later open Settings.
  const csPanel = page.getByTestId("connection-sheet-panel");
  if (await csPanel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(csPanel).toBeHidden({ timeout: 5000 });
  }
  return id;
}

/** Create a Docker profile, drive it to ready, and return the profile id.
 *  Unlike createDockerProfile, does not dismiss the connection sheet (the caller
 *  handles any sheet dismissal). */
async function createAndProvisionDockerProfile(page: import("@playwright/test").Page): Promise<string> {
  await openDockerSetupFromSwitcher(page);
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
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });
  return id;
}

// ---------------------------------------------------------------------------
// Risk fixtures (matching the RiskKind union)
// ---------------------------------------------------------------------------

const ROOT_RISK = {
  id: "root-1",
  kind: "rootExecution",
  fingerprint: "root:dev-id-work-api-dev",
  title: "Running as root",
  explanation: "Agent commands will run as root.",
  consequences: "Files may become root-owned.",
  continueLabel: "Allow root",
};

const EPHEMERAL_RISK = {
  id: "ephemeral-1",
  kind: "ephemeralData",
  fingerprint: "ephemeral:/home/dev/.local/share/pantoken:Ephemeral · container writable layer",
  title: "Ephemeral Pantoken root",
  explanation: "Pantoken data will be lost when this container is replaced.",
  consequences: "Sessions and runtime files will be lost.",
  continueLabel: "Accept risk",
};

const SOCKET_RISK = {
  id: "socket-1",
  kind: "dockerSocket",
  fingerprint: "socket:dev-id-work-api-dev:/var/run/docker.sock",
  title: "Docker socket exposed",
  explanation: "This container can control Docker on the host.",
  consequences: "Agent commands may gain host-level access.",
  continueLabel: "Accept risk",
};

/** An inspection fixture that includes a Docker socket mount (for dockerSocket risk). */
const INSPECTION_WITH_SOCKET = {
  name: "work-api-dev",
  containerId: "dev-id-work-api-dev",
  image: "node:20-alpine",
  running: true,
  configuredUser: "dev",
  resolvedUser: "dev",
  resolvedUid: 1000,
  resolvedGid: 1000,
  resolvedHome: "/home/dev",
  os: "linux",
  arch: "arm64",
  pantokenRootSuggestion: "/home/dev/.local/share/pantoken",
  mounts: [
    { type: "volume", name: "pantoken-data", destination: "/home/dev/.local/share/pantoken", readOnly: false },
    { type: "bind", source: "/var/run/docker.sock", destination: "/var/run/docker.sock", readOnly: false },
  ],
};

// ---------------------------------------------------------------------------
// Flow tests — container provisioning family
// ---------------------------------------------------------------------------

async function expectSharedAdvancedControls(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Advanced" }).click();
  const panel = page.getByTestId("computer-setup-panel");
  await expect(panel.getByRole("radiogroup", { name: "Polytoken policy" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: /Remote-root override/ })).toBeVisible();
  await expect(panel.getByLabel("Server binary path")).toBeVisible();
  await expect(panel.getByText("XDG mode", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Isolated", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Shared", { exact: true })).toHaveCount(0);
}

// Open the Setup Docker sheet and test SSH to reveal the container picker
test("Docker add Advanced keeps shared-root controls without XDG mode", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);
  await expectSharedAdvancedControls(page);
});

test("Setup Docker sheet opens and SSH test reveals the container picker", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await expect(page.getByTestId("cs-ssh-input")).toBeVisible();

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();

  // The dev provider resolves immediately, so the testing state is transient.
  // Container picker appears after test resolves.
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-ssh-summary")).toContainText("SSH connected");
});

// Select a container and start provisioning
test("Selecting a container and clicking Use starts provisioning", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

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

// Provisioning reaches ready and the sheet closes
test("Provisioning reaches ready and closes the sheet", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

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

// Exact-name fallback saves a stopped container without provisioning
test("Exact-name fallback saves without provisioning", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

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

// Customize target shows inspection details
test("Customize target shows inspection details", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

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

// SSH and name fields remain visible after discovery; editing SSH invalidates
// stale results (AC.7, AC.8)
test("SSH and name fields after discovery; editing SSH invalidates picker (AC.7, AC.8)", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // SSH input should still be visible and editable in the container picker stage.
  await expect(page.getByTestId("cs-ssh-input")).toBeVisible();
  await expect(page.getByTestId("cs-name-input")).toBeVisible();

  // Re-asserted: shared SSH-summary visibility from the "editing SSH" sub-flow.
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Edit the SSH destination — should invalidate the picker.
  await page.getByTestId("cs-ssh-input").fill("user@changed.example.com");

  // The picker summary should be gone, and we should be back at connection fields.
  await expect(page.getByTestId("cs-ssh-summary")).toBeHidden();
  // The test button should be visible again (connection fields stage).
  await expect(page.getByTestId("cs-test-ssh")).toBeVisible();
});

// Name suggestion appears when selecting a container (AC.9)
test("Name suggestion appears when selecting a container (AC.9)", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Select a container — name should be auto-suggested.
  await page.getByTestId("cs-container-work-api-dev").click();
  await expect(page.getByTestId("cs-name-input")).toHaveValue("Work API Dev");
});

// User-entered name is never overwritten by suggestion (AC.9)
test("User-entered name is never overwritten by suggestion (AC.9)", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

  await page.getByTestId("cs-name-input").fill("My Custom Name");
  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });

  // Select a container — the user-entered name should be preserved.
  await page.getByTestId("cs-container-work-api-dev").click();
  await expect(page.getByTestId("cs-name-input")).toHaveValue("My Custom Name");
});

// Desktop SSH row layout: input widths, port accessible label, action button
// intrinsic height
test("Desktop SSH row layout: input widths, port label, action button height", async ({ page }) => {
  await openDockerSetupFromSwitcher(page);

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

  // The port input's accessible name should be "Port".
  await expect(portInput).toHaveAccessibleName("Port");

  // The test SSH button should have an intrinsic height, not fill vertical space.
  const testBtn = page.getByTestId("cs-test-ssh");
  const box = await testBtn.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    // Intrinsic height: should be well under 100px (padding-based, ~44-50px).
    expect(Math.round(box.height)).toBeLessThan(100);
  }
});

// All three risks appear in the review panel and accepting them continues to
// provisioning
test("All three risks appear and accepting them continues to provisioning", async ({ page }) => {
  // Set a custom inspection with a Docker socket mount so the dockerSocket risk applies.
  await setInspection(page, "work-api-dev", INSPECTION_WITH_SOCKET);
  await setPendingRisksForNextDocker(page, [ROOT_RISK, EPHEMERAL_RISK, SOCKET_RISK]);
  await openSetupAndSelectContainer(page);

  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-risk-rootExecution")).toBeVisible();
  await expect(page.getByTestId("cs-risk-ephemeralData")).toBeVisible();
  await expect(page.getByTestId("cs-risk-dockerSocket")).toBeVisible();

  // Re-asserted: shared risks-panel visibility from the "accept risks" sub-flow.
  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-accept-risks").click();

  // Should transition to provisioning.
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
});

// Ephemeral-only risk shows both buttons; Choose another path returns to the
// container picker
test("Ephemeral-only risk shows both buttons and Choose another path returns to picker", async ({ page }) => {
  await setPendingRisksForNextDocker(page, [EPHEMERAL_RISK]);
  await openSetupAndSelectContainer(page);

  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-risk-ephemeralData")).toBeVisible();
  // Ephemeral-only variant shows both buttons.
  await expect(page.getByTestId("cs-choose-path")).toBeVisible();
  await expect(page.getByTestId("cs-accept-risks")).toBeVisible();

  // Re-asserted: shared risks-panel visibility from the "choose another path" sub-flow.
  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-choose-path").click();

  // Should be back at container picker.
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible();
  // Risk panel should be gone.
  await expect(page.getByTestId("cs-risks-panel")).toBeHidden();
});

// Container replacement shows reconnecting status, then failure UI
test("Container replacement shows reconnecting then failure UI", async ({ page }) => {
  test.setTimeout(60000);
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

  // Now drive the replacement to failure.
  await driveReplacement(page, id);
  await setState(page, id, "failed");

  // The connection sheet should show failure UI.
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("failure-section")).toBeVisible();
});

async function resetProfileCaptures(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __pantokenHosts?: { resetProfileCaptures: () => void } }).__pantokenHosts?.resetProfileCaptures());
}

async function lastProfileCapture(page: import("@playwright/test").Page, kind: "added" | "updated"): Promise<Record<string, unknown>> {
  return page.evaluate((kind) => {
    const hosts = (window as unknown as { __pantokenHosts?: { getLastAddedProfile: () => unknown; getLastUpdatedProfile: () => unknown } }).__pantokenHosts;
    return (kind === "added" ? hosts?.getLastAddedProfile() : hosts?.getLastUpdatedProfile()) as Record<string, unknown>;
  }, kind);
}

async function acknowledgementCaptures(page: import("@playwright/test").Page): Promise<Array<{ id: string; riskId: string; fingerprint: string }>> {
  return page.evaluate(() => (window as unknown as { __pantokenHosts?: { getAcknowledgementCaptures: () => Array<{ id: string; riskId: string; fingerprint: string }> } }).__pantokenHosts?.getAcknowledgementCaptures() ?? []);
}

// Docker profile appears in Computers section with Docker tag
test("docker_add_profile_payload_omits_xdg_mode_and_preserves_advanced_fields", async ({ page }) => {
  await resetProfileCaptures(page);
  await openDockerSetupFromSwitcher(page);
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("radio", { name: "Offer install" }).click();
  await page.getByTestId("cs-root-override-input").fill("/srv/docker-remote-root");
  await page.getByLabel("Server binary path").fill("/opt/docker-server");
  await setPendingRisksForNextDocker(page, [ROOT_RISK]);
  await page.getByTestId("cs-ssh-input").fill("user@docker-payload.test");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-customize-toggle").click();
  await page.getByTestId("cs-user-input").fill("root");
  await page.getByTestId("cs-root-input").fill("/srv/docker-root");
  await page.getByTestId("cs-workdir-input").fill("/workspace/payload");
  await page.getByTestId("cs-use-container").click();
  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-accept-risks").click();
  const profile = await lastProfileCapture(page, "added");
  expect(profile).toMatchObject({ sshDestination: "user@docker-payload.test", polytokenPolicy: "offerInstall", remoteRootOverride: "/srv/docker-remote-root", serverPath: "/opt/docker-server", executionTarget: { kind: "dockerContainer", containerName: "work-api-dev", user: "root", workdir: "/workspace/payload", pantokenRoot: "/srv/docker-root" } });
  expect(await acknowledgementCaptures(page)).toEqual([{ id: expect.any(String), riskId: "root-1", fingerprint: "root:dev-id-work-api-dev" }]);
  expect(profile).not.toHaveProperty("xdgMode");
  expect(profile).not.toHaveProperty("xdg_mode");
});

test("docker_edit_profile_payload_omits_xdg_mode_and_preserves_advanced_fields", async ({ page }) => {
  await createDockerProfile(page);
  await resetProfileCaptures(page);
  await openSettings(page, "computers");
  await page.locator("[data-testid^='computer-row-']").filter({ hasText: "Work API Dev" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("radio", { name: "Offer install" }).click();
  await page.getByTestId("cs-edit-root-override").fill("/srv/docker-edited");
  await page.getByLabel("Server binary path").fill("/opt/docker-server");
  await page.getByTestId("cs-reconnect-later").click();
  const profile = await lastProfileCapture(page, "updated");
  expect(profile).toMatchObject({ polytokenPolicy: "offerInstall", remoteRootOverride: "/srv/docker-edited", serverPath: "/opt/docker-server", executionTarget: { kind: "dockerContainer" } });
  expect(profile).not.toHaveProperty("xdgMode");
  expect(profile).not.toHaveProperty("xdg_mode");
  expect(await acknowledgementCaptures(page)).toEqual([]);
});

test("Docker profile appears in Computers section with Docker tag", async ({ page }) => {
  test.setTimeout(60000);
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

// Edit dialog shows exec env, docker target, and reconnect buttons (AC.10, AC.11)
test("Edit dialog shows exec env, docker target, and reconnect buttons", async ({ page }) => {
  test.setTimeout(60000);
  await createDockerProfile(page);
  await openSettings(page, "computers");

  const row = page.locator("[data-testid^='computer-row-']").filter({ hasText: "Work API Dev" });
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  // Edit stage should show the read-only exec env.
  await expect(page.getByTestId("cs-edit-exec-env")).toBeVisible();
  await expect(page.getByTestId("cs-edit-exec-env")).toContainText("Docker container");
  await expect(page.getByTestId("cs-edit-exec-env")).toContainText("immutable");
  // Docker target section should be present.
  await expect(page.getByTestId("cs-edit-docker-target")).toBeVisible();
  await expectSharedAdvancedControls(page);

  // Re-asserted: shared panel visibility from the "reconnect buttons" sub-flow.
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();

  await expect(page.getByTestId("cs-reconnect-now")).toBeVisible();
  await expect(page.getByTestId("cs-reconnect-later")).toBeVisible();
});

// Settings shows a single add button; Docker setup reachable via the sheet toggle
test("Settings shows a single add button; Docker setup reachable via the sheet toggle", async ({ page }) => {
  await openSettings(page, "computers");
  // Exactly one add entry — no separate "Setup Docker container" launcher.
  const section = page.getByTestId("computers-section");
  await expect(section.getByTestId("add-computer-btn")).toBeVisible();
  await expect(section.getByTestId("settings-setup-docker")).toHaveCount(0);
  // Docker setup is reachable by opening the sheet and selecting the segment.
  await section.getByTestId("add-computer-btn").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeVisible();
  await page.getByTestId("cs-env-docker").click();
  await expect(page.getByTestId("cs-ssh-input")).toBeVisible();
});

// Container not running state shows in Computers section
test("Container not running state shows in Computers section", async ({ page }) => {
  // Create a profile via exact-name fallback (no provisioning).
  await openDockerSetupFromSwitcher(page);
  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-exact-name-link").click();
  await page.getByTestId("cs-exact-input").fill("stopped-container");
  await page.getByTestId("cs-save-later").click();
  await expect(page.getByTestId("computer-setup-panel")).toBeHidden({ timeout: 10000 });

  // Check it appears in Settings as disconnected.
  await openSettings(page, "computers");
  const section = page.getByTestId("computers-section");
  await expect(section).toContainText("Stopped Container");
});
