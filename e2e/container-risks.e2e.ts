import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

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

/** Drive provisioning phase via window.__pantokenHosts. */
async function driveProvisioningPhase(page: import("@playwright/test").Page, id: string, phase: number): Promise<void> {
  await page.evaluate(
    ({ id, phase }) => (window as unknown as { __pantokenHosts?: { driveProvisioningPhase: (id: string, phase: number) => void } }).__pantokenHosts?.driveProvisioningPhase(id, phase),
    { id, phase },
  );
}

/** Standard risk fixtures matching the RiskKind union. */
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

async function openSetupAndSelectContainer(page: import("@playwright/test").Page): Promise<void> {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await switcher.getByTestId("host-switcher-setup-docker").click();
  await page.getByTestId("cs-ssh-input").fill("user@dev.example.com");
  await page.getByTestId("cs-test-ssh").click();
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-container-work-api-dev").click();
  await page.getByTestId("cs-use-container").click();
}

test("All three risks appear in the review panel", async ({ page }) => {
  // Set a custom inspection with a Docker socket mount so the dockerSocket risk applies.
  await setInspection(page, "work-api-dev", INSPECTION_WITH_SOCKET);
  await setPendingRisksForNextDocker(page, [ROOT_RISK, EPHEMERAL_RISK, SOCKET_RISK]);
  await openSetupAndSelectContainer(page);

  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-risk-rootExecution")).toBeVisible();
  await expect(page.getByTestId("cs-risk-ephemeralData")).toBeVisible();
  await expect(page.getByTestId("cs-risk-dockerSocket")).toBeVisible();
});

test("Accept risks continues to provisioning", async ({ page }) => {
  await setPendingRisksForNextDocker(page, [ROOT_RISK, EPHEMERAL_RISK, SOCKET_RISK]);
  await openSetupAndSelectContainer(page);

  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-accept-risks").click();

  // Should transition to provisioning.
  await expect(page.getByTestId("cs-provisioning")).toBeVisible({ timeout: 10000 });
});

test("Ephemeral-only risk shows Choose another path button", async ({ page }) => {
  await setPendingRisksForNextDocker(page, [EPHEMERAL_RISK]);
  await openSetupAndSelectContainer(page);

  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("cs-risk-ephemeralData")).toBeVisible();
  // Ephemeral-only variant shows both buttons.
  await expect(page.getByTestId("cs-choose-path")).toBeVisible();
  await expect(page.getByTestId("cs-accept-risks")).toBeVisible();
});

test("Choose another path returns to container picker", async ({ page }) => {
  await setPendingRisksForNextDocker(page, [EPHEMERAL_RISK]);
  await openSetupAndSelectContainer(page);

  await expect(page.getByTestId("cs-risks-panel")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("cs-choose-path").click();

  // Should be back at container picker.
  await expect(page.getByTestId("cs-ssh-summary")).toBeVisible();
  // Risk panel should be gone.
  await expect(page.getByTestId("cs-risks-panel")).toBeHidden();
});
