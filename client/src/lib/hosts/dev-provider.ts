import type { ServerMessage, SessionAttention } from "@pantoken/protocol";
import type {
  ContainerInspection,
  ContainerSummary,
  HostActivity,
  HostConnectionState,
  NativeHostDescriptor,
  PendingRisk,
  PreflightPhase,
  RemoteProfile,
  TestSshResult,
} from "./types.js";
import type { HostProvider } from "./provider.js";

export interface DevProfileCaptures {
  added: RemoteProfile[];
  updated: RemoteProfile[];
  acknowledgements: Array<{ id: string; riskId: string; fingerprint: string }>;
}

export interface DevHostControls {
  setState(id: string, state: HostConnectionState): void;
  setActivity(id: string, activity: HostActivity): void;
  emit(id: string, message: ServerMessage): void;
  setMessageSink(sink: ((id: string, message: ServerMessage) => void) | null): void;
  // ── Docker-state hooks ──────────────────────────────────────────────────
  /** Set the pending risks surfaced for a host during awaitingAcknowledgement. */
  setPendingRisks(id: string, risks: PendingRisk[]): void;
  /** Pre-register risks to apply to the next docker profile created (e2e). */
  setPendingRisksForNextDocker(risks: PendingRisk[]): void;
  /** Set the preflight phase surfaced for a host during preflight. */
  setPreflightPhase(id: string, phase: PreflightPhase): void;
  /** Set the containers returned by testSshAndListContainers. */
  setContainerPicker(id: string, containers: ContainerSummary[]): void;
  /** Drive the provisioning phase (1-4) for a host. */
  driveProvisioningPhase(id: string, phase: number): void;
  /** Simulate a container replacement (new container ID under the same name). */
  driveReplacement(id: string): void;
  /** Get the inspection data for a container name (or null). */
  getInspection(containerName: string): ContainerInspection | null;
  /** Set the inspection data for a container name. */
  setInspection(containerName: string, inspection: ContainerInspection): void;
  /** Toggle whether Docker container targets are supported (PWA-degradation test hook). */
  setSupportsContainerTargets(enabled: boolean): void;
  setFailure(id: string, label: string, action?: string, detail?: string): void;
  /** Return cloned profile/acknowledgement payloads captured by the dev provider. */
  getProfileCaptures(): DevProfileCaptures;
  /** Clear captured profile/acknowledgement payloads. */
  resetProfileCaptures(): void;
  /** Return the latest captured add/update/ack payloads for assertions. */
  getLastAddedProfile(): RemoteProfile | null;
  getLastUpdatedProfile(): RemoteProfile | null;
  getAcknowledgementCaptures(): Array<{ id: string; riskId: string; fingerprint: string }>;
  // ── Deterministic async hooks for testing ─────────────────────────────────
  /** Control the next addProfile call: delay, reject, or resolve normally. */
  setNextAddProfileBehavior(behavior: { delay?: number; reject?: unknown } | null): void;
  /** Control the next updateProfile call. */
  setNextUpdateProfileBehavior(behavior: { delay?: number; reject?: unknown } | null): void;
  /** Control the next connectHost call. */
  setNextConnectHostBehavior(behavior: { delay?: number; reject?: unknown } | null): void;
  /** Control the next testSshAndListContainers call. */
  setNextTestSshBehavior(
    behavior: { delay?: number; reject?: unknown; result?: TestSshResult } | null,
  ): void;
  /** Control the next inspectContainer call. */
  setNextInspectContainerBehavior(behavior: { delay?: number; reject?: unknown } | null): void;
  /** Control the next acknowledgeRisk call. */
  setNextAcknowledgeRiskBehavior(behavior: { delay?: number; reject?: unknown } | null): void;
  /** Control the next resumeConnection call. */
  setNextResumeConnectionBehavior(behavior: { delay?: number; reject?: unknown } | null): void;
}

export type DevHostProvider = HostProvider & DevHostControls;

/** Default container fixtures for the dev provider. */
const DEV_CONTAINERS: ContainerSummary[] = [
  {
    name: "work-api-dev",
    image: "node:20-alpine",
    state: "running",
    configuredUser: "dev",
    composeProject: "work-api",
    composeService: "api",
  },
  {
    name: "postgres-dev",
    image: "postgres:16",
    state: "running",
    configuredUser: "",
  },
  {
    name: "redis-cache",
    image: "redis:7-alpine",
    state: "running",
    configuredUser: "",
  },
];

/** Default inspection fixture for the dev provider. */
function defaultInspection(containerName: string): ContainerInspection {
  return {
    name: containerName,
    containerId: `dev-id-${containerName}-${Date.now()}`,
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
      {
        type: "volume",
        name: "pantoken-data",
        destination: "/home/dev/.local/share/pantoken",
        readOnly: false,
      },
    ],
  };
}

/** Deterministic multi-host provider used only by ?dev previews/e2e. */
export function createDevHostProvider(wsUrl: string): DevHostProvider {
  const hostMap = new Map<string, NativeHostDescriptor>([
    ["local", {
      id: "local", kind: "local", label: "Dev computer", subtitle: "This computer",
      state: "ready", wsUrl,
    }],
    ["dev-remote", {
      id: "dev-remote", kind: "remote", label: "Dev remote", subtitle: "dev@example.test",
      state: "disconnected",
    }],
  ]);
  let sink: ((id: string, message: ServerMessage) => void) | null = null;
  const profileMap = new Map<string, RemoteProfile>();
  // Docker state maps.
  const pendingRisksMap = new Map<string, PendingRisk[]>();
  const preflightPhaseMap = new Map<string, PreflightPhase>();
  const containerPickerMap = new Map<string, ContainerSummary[]>();
  const inspectionMap = new Map<string, ContainerInspection>();
  const provisioningPhaseMap = new Map<string, number>();
  const acknowledgedRisks = new Map<string, Set<string>>(); // hostId → set of riskIds acknowledged
  const profileCaptures: DevProfileCaptures = {
    added: [],
    updated: [],
    acknowledgements: [],
  };
  const containerIdMap = new Map<string, string>(); // hostId → current containerId
  // Pre-registered risks to apply to the next docker profile created (for e2e).
  let nextDockerRisks: PendingRisk[] | null = null;
  // Mutable toggle for supportsContainerTargets (default true; tests opt into
  // the false/PWA-degradation path via setSupportsContainerTargets).
  let supportsDockerFlag = true;

  // ── Deterministic async hooks for testing ─────────────────────────────────
  // Each hook is a one-shot: the next call to the corresponding method applies
  // the behavior (delay, reject, or resolve normally), then clears it.
  // `result` lets tests drive a specific return value — e.g. an `sshOk: false`
  // TestSshResult with sshErrorDetail — without touching the resolve path.
  type NextBehavior = { delay?: number; reject?: unknown; result?: TestSshResult } | null;
  let nextAddProfile: NextBehavior = null;
  let nextUpdateProfile: NextBehavior = null;
  let nextConnectHost: NextBehavior = null;
  let nextTestSsh: NextBehavior = null;
  let nextInspectContainer: NextBehavior = null;
  let nextAcknowledgeRisk: NextBehavior = null;
  let nextResumeConnection: NextBehavior = null;

  /** Apply a one-shot behavior: wait delay ms, then reject or resolve. */
  async function applyBehavior<T>(
    behavior: NextBehavior,
    resolve: () => T,
  ): Promise<T> {
    if (!behavior) return resolve();
    if (behavior.delay) await new Promise((r) => setTimeout(r, behavior.delay));
    if (behavior.reject !== undefined) throw behavior.reject;
    return resolve();
  }

  /** Check whether all pending risks for a host have been acknowledged. */
  function allRisksAcknowledged(hostId: string, risks: PendingRisk[]): boolean {
    const acked = acknowledgedRisks.get(hostId);
    if (!acked) return risks.length === 0;
    return risks.every((r) => acked.has(r.id));
  }

  const emit = (id: string, message: ServerMessage): void => sink?.(id, message);
  const setState = (id: string, state: HostConnectionState): void => {
    const host = hostMap.get(id);
    if (!host) return;
    hostMap.set(id, {
      ...host,
      state,
      wsUrl: state === "ready" ? wsUrl : host.wsUrl,
      ...(state === "ready" ? { failureLabel: undefined, failureAction: undefined, failureDetail: undefined } : {}),
    });
  };
  const setActivity = (id: string, activity: HostActivity): void => {
    const attention: SessionAttention[] = [];
    if (activity.waiting) attention.push({ sessionId: `${id}-waiting`, phase: "waiting", updatedAt: new Date().toISOString() });
    if (activity.failed) attention.push({ sessionId: `${id}-failed`, phase: "failed", updatedAt: new Date().toISOString() });
    emit(id, {
      type: "sessionStatus",
      runningIds: activity.running ? [`${id}-running`] : [],
      initializingIds: [],
      attention,
    } as ServerMessage);
    if (activity.unseen) {
      emit(id, {
        type: "sessionStatus",
        runningIds: [],
        initializingIds: [],
        attention,
      } as ServerMessage);
    }
  };

  const setPendingRisks = (id: string, risks: PendingRisk[]): void => {
    pendingRisksMap.set(id, risks);
    const host = hostMap.get(id);
    if (host) {
      hostMap.set(id, { ...host, pendingRisks: risks });
    }
  };

  const setPreflightPhase = (id: string, phase: PreflightPhase): void => {
    preflightPhaseMap.set(id, phase);
    const host = hostMap.get(id);
    if (host) {
      hostMap.set(id, { ...host, preflightPhase: phase });
    }
  };

  const setContainerPicker = (_id: string, containers: ContainerSummary[]): void => {
    // The dev provider uses a single global picker since testSshAndListContainers
    // is called before a profile is saved (no host id yet).
    containerPickerMap.set("__default__", containers);
  };

  const driveProvisioningPhase = (id: string, phase: number): void => {
    provisioningPhaseMap.set(id, phase);
    // Map phases 1-4 to connection states.
    if (phase === 4) {
      setState(id, "ready");
    } else {
      setState(id, "provisioning");
    }
  };

  const driveReplacement = (id: string): void => {
    // Generate a new container ID and set reconnecting state.
    containerIdMap.set(id, `replaced-${Date.now()}`);
    setState(id, "reconnecting");
  };

  const getInspection = (containerName: string): ContainerInspection | null => {
    return inspectionMap.get(containerName) ?? null;
  };

  const setInspection = (containerName: string, inspection: ContainerInspection): void => {
    inspectionMap.set(containerName, inspection);
  };

  const setFailure = (id: string, label: string, action?: string, detail?: string): void => {
    const host = hostMap.get(id);
    if (!host) return;
    hostMap.set(id, {
      ...host,
      state: "failed",
      failureLabel: label,
      failureAction: action,
      failureDetail: detail,
    });
  };


  return {
    supportsMultiHost: () => true,
    listHosts: async () => [...hostMap.values()].map((host) => ({ ...host })),
    connectHost: async (id) => {
      const behavior = nextConnectHost;
      nextConnectHost = null;
      await applyBehavior(behavior, () => {
        const host = hostMap.get(id);
        if (!host) throw new Error("Computer not found");
        if (host.state === "failed") throw new Error(host.failureLabel ?? "Connection failed");
        return undefined;
      });
      // The actual connection logic (runs after behavior delay/reject).
      const host = hostMap.get(id);
      if (!host) throw new Error("Computer not found");
      if (host.state === "failed") throw new Error(host.failureLabel ?? "Connection failed");
      // If there are unacknowledged pending risks, transition directly to
      // awaitingAcknowledgement (mirrors the real backend's preflight that
      // surfaces risks before proceeding). Resolves immediately so the
      // coordinator's non-terminal handling kicks in.
      const risks = pendingRisksMap.get(id);
      if (risks && risks.length > 0 && !allRisksAcknowledged(id, risks)) {
        setState(id, "awaitingAcknowledgement");
        return;
      }
      setState(id, "testingSsh");
      // If pending risks were injected (via setPendingRisks), transition
      // directly to awaitingAcknowledgement so the UI can render them.
      if (pendingRisksMap.get(id)?.length) {
        setState(id, "awaitingAcknowledgement");
        return;
      }
      // No risks — simulate connection progress: preflight → provisioning.
      // The test or coordinator drives further state changes via
      // driveProvisioningPhase / setState.
      setState(id, "preflight");
      setState(id, "provisioning");
      provisioningPhaseMap.set(id, 1);
    },
    disconnectHost: async (id) => setState(id, "disconnected"),
    listProfiles: async () => [...profileMap.values()].map((p) => structuredClone(p)),
    getProfile: async (id) => {
      const p = profileMap.get(id);
      return p ? structuredClone(p) : null;
    },
    addProfile: async (profile) => {
      const behavior = nextAddProfile;
      nextAddProfile = null;
      return applyBehavior(behavior, () => {
        const stored = structuredClone(profile);
        profileCaptures.added.push(structuredClone(profile));
        profileMap.set(profile.id, stored);
        // If it's a Docker profile, add a corresponding host descriptor.
        if (profile.executionTarget.kind === "dockerContainer") {
          const hostId = profile.id;
          const containerName = profile.executionTarget.containerName;
          const { host: sshHost } = profile.sshDestination.includes("@")
            ? { host: profile.sshDestination.split("@")[1] ?? profile.sshDestination }
            : { host: profile.sshDestination };
          hostMap.set(hostId, {
            id: hostId,
            kind: "remote",
            label: profile.label,
            subtitle: `${containerName} via ${sshHost}`,
            state: "disconnected",
            isDockerTarget: true,
          });
          // Set a default container ID.
          containerIdMap.set(hostId, `dev-id-${containerName}`);
          // Apply pre-registered risks for e2e testing (set via setPendingRisksForNextDocker).
          if (nextDockerRisks) {
            pendingRisksMap.set(hostId, nextDockerRisks);
            hostMap.set(hostId, {
              ...hostMap.get(hostId)!,
              pendingRisks: nextDockerRisks,
            });
            nextDockerRisks = null;
          }
        } else {
          // Host profile — add a non-docker descriptor.
          hostMap.set(profile.id, {
            id: profile.id,
            kind: "remote",
            label: profile.label,
            subtitle: profile.sshDestination,
            state: "disconnected",
            isDockerTarget: false,
          });
        }
        return structuredClone(stored);
      });
    },
    updateProfile: async (profile) => {
      const behavior = nextUpdateProfile;
      nextUpdateProfile = null;
      await applyBehavior(behavior, () => undefined);
      profileCaptures.updated.push(structuredClone(profile));
      profileMap.set(profile.id, structuredClone(profile));
    },
    deleteProfile: async (id) => {
      profileMap.delete(id);
      hostMap.delete(id);
      pendingRisksMap.delete(id);
      preflightPhaseMap.delete(id);
      provisioningPhaseMap.delete(id);
      acknowledgedRisks.delete(id);
      containerIdMap.delete(id);
    },
    acknowledgeRisk: async (id, riskId, fingerprint) => {
      profileCaptures.acknowledgements.push({ id, riskId, fingerprint });
      const behavior = nextAcknowledgeRisk;
      nextAcknowledgeRisk = null;
      await applyBehavior(behavior, () => {
        const risks = pendingRisksMap.get(id);
        if (!risks || risks.length === 0) {
          throw new Error(`no pending risks for host ${id}`);
        }
        const risk = risks.find((r) => r.id === riskId);
        if (!risk) {
          throw new Error(`no pending risk ${riskId} for host ${id}`);
        }
        if (risk.fingerprint !== fingerprint) {
          throw new Error(`fingerprint mismatch for risk ${riskId}: target changed`);
        }
        let acked = acknowledgedRisks.get(id);
        if (!acked) {
          acked = new Set();
          acknowledgedRisks.set(id, acked);
        }
        acked.add(riskId);
        return undefined;
      });
    },
    cancelConnection: async (id) => {
      setState(id, "disconnected");
      pendingRisksMap.delete(id);
      preflightPhaseMap.delete(id);
      const host = hostMap.get(id);
      if (host) {
        hostMap.set(id, { ...host, pendingRisks: undefined, preflightPhase: undefined });
      }
    },
    resumeConnection: async (id) => {
      const behavior = nextResumeConnection;
      nextResumeConnection = null;
      await applyBehavior(behavior, () => {
        const host = hostMap.get(id);
        if (!host) return undefined;
        // Resume from awaitingAcknowledgement / preflight → provisioning → ready.
        if (host.state === "awaitingAcknowledgement" || host.state === "preflight") {
          // Check if all risks are acknowledged.
          const risks = pendingRisksMap.get(id);
          if (risks && !allRisksAcknowledged(id, risks)) {
            // Still has unacknowledged risks — stay in awaitingAcknowledgement.
            return undefined;
          }
          setState(id, "provisioning");
          // Clear pending risks.
          pendingRisksMap.delete(id);
          hostMap.set(id, { ...host, pendingRisks: undefined, preflightPhase: undefined, state: "provisioning" });
        }
        return undefined;
      });
    },
    // ── Docker container target methods ────────────────────────────────────
    supportsContainerTargets: () => supportsDockerFlag,
    testSshAndListContainers: async (_sshDestination, _port?) => {
      const behavior = nextTestSsh;
      nextTestSsh = null;
      return applyBehavior(behavior, () => {
        if (behavior?.result) return behavior.result;
        const containers = containerPickerMap.get("__default__") ?? DEV_CONTAINERS;
        return {
          sshOk: true,
          dockerPermission: "granted" as const,
          containers: structuredClone(containers),
        };
      });
    },
    inspectContainer: async (_sshDestination, _port, containerName) => {
      const behavior = nextInspectContainer;
      nextInspectContainer = null;
      return applyBehavior(behavior, () => {
        const cached = inspectionMap.get(containerName);
        if (cached) return structuredClone(cached);
        return structuredClone(defaultInspection(containerName));
      });
    },
    // ── DevHostControls ───────────────────────────────────────────────────
    setState,
    setActivity,
    emit,
    setFailure,
    getProfileCaptures: () => structuredClone(profileCaptures),
    resetProfileCaptures: () => {
      profileCaptures.added.length = 0;
      profileCaptures.updated.length = 0;
      profileCaptures.acknowledgements.length = 0;
    },
    getLastAddedProfile: () => structuredClone(profileCaptures.added.at(-1) ?? null),
    getLastUpdatedProfile: () => structuredClone(profileCaptures.updated.at(-1) ?? null),
    getAcknowledgementCaptures: () => structuredClone(profileCaptures.acknowledgements),
    setMessageSink: (next) => { sink = next; },
    setPendingRisks,
    setPendingRisksForNextDocker: (risks: PendingRisk[]) => { nextDockerRisks = risks; },
    setPreflightPhase,
    setContainerPicker,
    driveProvisioningPhase,
    driveReplacement,
    getInspection,
    setInspection,
    setSupportsContainerTargets: (enabled: boolean) => { supportsDockerFlag = enabled; },
    // ── Deterministic async hooks for testing ───────────────────────────────
    setNextAddProfileBehavior: (b: NextBehavior) => { nextAddProfile = b; },
    setNextUpdateProfileBehavior: (b: NextBehavior) => { nextUpdateProfile = b; },
    setNextConnectHostBehavior: (b: NextBehavior) => { nextConnectHost = b; },
    setNextTestSshBehavior: (b: NextBehavior) => { nextTestSsh = b; },
    setNextInspectContainerBehavior: (b: NextBehavior) => { nextInspectContainer = b; },
    setNextAcknowledgeRiskBehavior: (b: NextBehavior) => { nextAcknowledgeRisk = b; },
    setNextResumeConnectionBehavior: (b: NextBehavior) => { nextResumeConnection = b; },
  };
}
