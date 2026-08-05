import { describe, expect, test } from "vitest";
import {
  formatProvisioningSummary,
  formatProvisioningTitle,
  getProvisioningCopy,
  type ProvisioningMode,
} from "./provisioning-copy.js";

const MODES: ProvisioningMode[] = ["host", "docker"];

describe("provisioning copy", () => {
  test("exposes the complete Host copy", () => {
    expect(getProvisioningCopy("host")).toEqual({
      subtitle: "Setting up remote host",
      phaseLabels: [
        "SSH connection",
        "Remote system",
        "Polytoken compatibility",
        "Pantoken runtime",
      ],
      phaseDetails: [
        "SSH connection established",
        "Checking remote system",
        "Checking compatibility",
        "Starting runtime",
      ],
      fallbackTarget: "remote host",
    });
  });

  test("exposes the complete Docker copy without changing its details", () => {
    expect(getProvisioningCopy("docker")).toEqual({
      subtitle: "Setting up Docker target",
      phaseLabels: ["SSH & Docker", "Container", "Polytoken", "Pantoken runtime"],
      phaseDetails: [
        "SSH connected · Docker CLI available",
        "Locating container by name · inspecting identity…",
        "Checking compatibility",
        "Starting runtime",
      ],
      fallbackTarget: "Docker target",
    });
  });

  test("Host copy contains no Docker or container vocabulary", () => {
    const hostCopy = JSON.stringify(getProvisioningCopy("host")).toLowerCase();
    expect(hostCopy).not.toContain("docker");
    expect(hostCopy).not.toContain("container");
  });

  test.each(MODES)("formats the %s provisioning summary", (mode) => {
    expect(formatProvisioningSummary(mode, "remote.test", "work-api-dev")).toBe(
      mode === "host"
        ? "SSH host: remote.test"
        : "work-api-dev via remote.test",
    );
  });

  test.each(MODES)("formats the %s named provisioning title", (mode) => {
    expect(formatProvisioningTitle(mode, "Build host")).toBe(
      "Connecting to Build host",
    );
  });

  test("uses the mode-specific fallback provisioning title", () => {
    expect(formatProvisioningTitle("host", "")).toBe(
      "Connecting to remote host",
    );
    expect(formatProvisioningTitle("docker", "")).toBe(
      "Connecting to Docker target",
    );
  });
});
