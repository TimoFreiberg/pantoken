export type ProvisioningMode = "host" | "docker";

export interface ProvisioningCopy {
  readonly subtitle: string;
  readonly phaseLabels: readonly [string, string, string, string];
  readonly phaseDetails: readonly [string, string, string, string];
  readonly fallbackTarget: string;
}

const HOST_COPY: ProvisioningCopy = {
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
};

const DOCKER_COPY: ProvisioningCopy = {
  subtitle: "Setting up Docker target",
  phaseLabels: ["SSH & Docker", "Container", "Polytoken", "Pantoken runtime"],
  phaseDetails: [
    "SSH connected · Docker CLI available",
    "Locating container by name · inspecting identity…",
    "Checking compatibility",
    "Starting runtime",
  ],
  fallbackTarget: "Docker target",
};

export function getProvisioningCopy(mode: ProvisioningMode): ProvisioningCopy {
  return mode === "host" ? HOST_COPY : DOCKER_COPY;
}

export function formatProvisioningSummary(
  mode: ProvisioningMode,
  sshHost: string,
  containerName: string,
): string {
  return mode === "host"
    ? `SSH host: ${sshHost}`
    : `${containerName} via ${sshHost}`;
}

export function formatProvisioningTitle(
  mode: ProvisioningMode,
  name: string,
): string {
  return `Connecting to ${name || getProvisioningCopy(mode).fallbackTarget}`;
}
