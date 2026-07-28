<script lang="ts">
  import { tick } from "svelte";
  import { overlayHistory, PHONE_MQ } from "../lib/overlay-history.js";
  import { profileEditor } from "../lib/profile-editor.svelte.js";
  import {
    validateProfileDraft,
    isDirty,
    normalizeError,
    defaultDraft,
    draftFromProfile,
    draftToExecutionTargetProfile,
    toValidationDraft,
    type ComputerSetupDraft,
    type ProfileFormDraft,
    type SetupError,
  } from "../lib/profile-form.js";
  import type { HostCoordinator } from "../lib/hosts.svelte.js";
  import type {
    ContainerInspection,
    ContainerSummary,
    PendingRisk,
    PolytokenPolicy,
    RemoteProfile,
    TestSshResult,
    XdgMode,
  } from "../lib/hosts/types.js";
  import type { HostProvider } from "../lib/hosts/provider.js";
  import {
    humanizeContainerName,
    humanizeSshHost,
    suggestPantokenRoot,
    formatBacking,
    findSocketMount,
    RISK_BODIES,
    risksNeedingAcknowledgement,
  } from "../lib/hosts/docker-format.js";
  import { redactSshDestination } from "../lib/hosts/types.js";
  import Button from "./ui/Button.svelte";
  import SegmentedControl from "./ui/SegmentedControl.svelte";
  import Chevron from "./ui/Chevron.svelte";

  // ── Props ────────────────────────────────────────────────────────────────
  const { coordinator }: { coordinator: HostCoordinator } = $props();
  const provider: HostProvider = coordinator.hostProvider;

  // ── Dialog state ──────────────────────────────────────────────────────────
  const open = $derived(profileEditor.open);
  const editing = $derived(profileEditor.editing);
  let phone = $state(false);
  let panelEl = $state<HTMLDivElement>();
  let historyTracked = false;

  // ── Setup state machine ──────────────────────────────────────────────────
  type Stage =
    | "connectionFields" // SSH fields + segmented control + Advanced
    | "testingSsh" // SSH test in progress
    | "sshFailed" // SSH test failed
    | "choosingContainer" // Container picker
    | "exactName" // Exact-name fallback
    | "reviewingRisks" // Risk panel
    | "provisioning" // Four-phase provisioning
    | "provisioningFailed" // Provisioning failure
    | "editing"; // Edit dialog

  let stage = $state<Stage>("connectionFields");
  let nameTouched = $state(false);
  let rootTouched = $state(false);

  // ── Async operation state machine (Phase 6) ──────────────────────────────
  type SetupOperation =
    | { kind: "idle" }
    | { kind: "testingSsh" }
    | { kind: "inspectingContainer" }
    | { kind: "savingProfile" }
    | { kind: "connecting" }
    | { kind: "acknowledgingRisks" }
    | { kind: "updatingProfile" }
    | { kind: "failed"; error: SetupError };

  let operation = $state<SetupOperation>({ kind: "idle" });

  function isPending(): boolean {
    const k = operation.kind;
    return k !== "idle" && k !== "failed";
  }

  // ── Transient state (NOT part of the draft) ───────────────────────────────
  // Test results
  let testResult = $state<TestSshResult | null>(null);
  let testError = $state<{ title: string; message: string } | null>(null);
  let testSubStep = $state(0);

  // Container selection (selectedContainer is transient; exactContainerName is
  // in the draft as containerName)
  let selectedContainer = $state<ContainerSummary | null>(null);
  let containerSearch = $state("");
  let inspection = $state<ContainerInspection | null>(null);
  let inspectionError = $state<string | null>(null);

  // Risk state
  let pendingRisks = $state<PendingRisk[]>([]);
  let riskError = $state<string | null>(null);

  // Provisioning state
  let provisioningPhase = $state(1);
  let provisioningFailed = $state<{
    title: string;
    message: string;
    detail?: string;
    savedButNotConnected?: boolean;
  } | null>(null);
  let showTechnicalDetails = $state(false);
  let savedProfileId = $state<string | null>(null);
  let backgrounded = $state(false);

  // Edit state
  let editProfile = $state<RemoteProfile | null>(null);

  // Snapshot of SSH fields at the time of the last successful test, for
  // invalidation. null = no test performed yet.
  let testedSnapshot = $state<{
    sshDestination: string;
    port: string;
    execEnv: "host" | "docker";
  } | null>(null);

  // Discard confirmation dialog
  let showDiscardConfirm = $state(false);

  // Advanced/customize disclosure state
  let advancedOpen = $state(false);
  let customizeOpen = $state(false);

  // ── Draft accessors (read/write to profileEditor.draft) ───────────────────
  // The draft lives in profileEditor so it survives remounts. These accessors
  // provide convenient reads/writes. When the draft is null (loading), they
  // return safe defaults.

  const draft = $derived(profileEditor.draft);

  // Convenience field accessors with null-safety
  const name = $derived(draft?.name ?? "");
  const sshDestination = $derived(draft?.sshDestination ?? "");
  const port = $derived(draft?.port ?? "22");
  const execEnv = $derived(draft?.executionTarget ?? "docker");
  const polytokenPolicy = $derived(draft?.polytokenPolicy ?? "requireExisting");
  const remoteRootOverride = $derived(draft?.remoteRootOverride ?? "");
  const serverPath = $derived(draft?.serverPath ?? "");
  const xdgMode = $derived(draft?.xdgMode ?? "isolated");
  const containerName = $derived(draft?.containerName ?? "");
  const containerUser = $derived(draft?.containerUser ?? "");
  const pantokenRoot = $derived(draft?.pantokenRoot ?? "");
  const containerWorkdir = $derived(draft?.containerWorkdir ?? "");

  // ── Dirty detection (Phase 3.2) ───────────────────────────────────────────
  let dirty = $derived(isDirty(profileEditor.baseline, profileEditor.draft));

  // ── Computed ─────────────────────────────────────────────────────────────
  const supportsDocker = $derived(provider.supportsContainerTargets());
  const containers = $derived(testResult?.containers ?? []);
  const sortedContainers = $derived(
    [...containers].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const filteredContainers = $derived(
    containerSearch.trim()
      ? sortedContainers.filter((c) =>
          c.name.toLowerCase().includes(containerSearch.toLowerCase()),
        )
      : sortedContainers,
  );
  const showSearch = $derived(containers.length > 6);
  const sshHost = $derived(redactSshDestination(sshDestination).host);
  const isEphemeralOnly = $derived(
    pendingRisks.length === 1 && pendingRisks[0]?.kind === "ephemeralData",
  );

  // Primary action label derived from execEnv.
  const primaryLabel = $derived(
    execEnv === "host" ? "Test SSH & connect" : "Test SSH & find containers",
  );

  // Whether the connection-fields block should render.
  const showConnectionFields = $derived(
    stage === "connectionFields" ||
    stage === "testingSsh" ||
    stage === "sshFailed" ||
    stage === "choosingContainer" ||
    stage === "exactName",
  );

  // Provisioning phase labels
  const PHASE_LABELS = ["SSH & Docker", "Container", "Polytoken", "Pantoken runtime"];
  const safelyCancellable = $derived(provisioningPhase <= 2);

  // ── Phone detection ──────────────────────────────────────────────────────
  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(PHONE_MQ);
    const update = () => (phone = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  // ── Draft persistence (Phase 2.4) ─────────────────────────────────────────
  // Debounced localStorage write on draft change.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Track the draft for reactivity
    const d = profileEditor.draft;
    if (!d) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => profileEditor.persistDraft(), 500);
  });

  // ── Open/close lifecycle ─────────────────────────────────────────────────
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      resetState();
      // Derive initial execEnv from the launch intent.
      const intent = profileEditor.intent;
      if (intent?.kind === "new" && profileEditor.draft) {
        // The draft was already set by openNew/openNewDocker.
        // execEnv is derived from draft.executionTarget.
      }
      if (editing) {
        void loadEditProfile(editing);
      }
      overlayHistory.opened("computer-setup", closeFromHistory);
      historyTracked = phone;
      void focusFirstField();
    }
    if (!open && prevOpen) {
      overlayHistory.closed("computer-setup");
      historyTracked = false;
    }
    prevOpen = open;
  });

  // ── Focus management (Phase 5) ─────────────────────────────────────────────

  /** Focus the first relevant text field after render. */
  async function focusFirstField(): Promise<void> {
    await tick();
    await tick();
    if (stage === "editing") {
      panelEl?.querySelector<HTMLInputElement>("#cs-edit-name")?.focus();
    } else {
      panelEl?.querySelector<HTMLInputElement>("#cs-name")?.focus();
    }
  }

  /** Focus the first invalid field after a validation failure. */
  function focusFirstInvalid(): void {
    const invalid = panelEl?.querySelector<HTMLElement>(
      '[data-invalid="true"]',
    );
    if (invalid) {
      invalid.focus();
      return;
    }
    // Fallback: focus the name field.
    panelEl?.querySelector<HTMLInputElement>("#cs-name")?.focus();
  }

  function closeFromHistory(): void {
    // Route through requestClose so dirty drafts get the discard prompt.
    requestClose();
  }

  /** Restore focus to the launching control (or a fallback). */
  function restoreFocus(): void {
    const launcher = profileEditor.launcher;
    if (launcher && launcher.isConnected) {
      launcher.focus();
      return;
    }
    // Fallback: try to find a stable control on the launching surface.
    const origin = profileEditor.launchOrigin;
    if (origin === "hostSwitcher") {
      const trigger = document.querySelector<HTMLElement>("[data-testid='host-switcher-trigger']");
      if (trigger) {
        trigger.focus();
        return;
      }
    } else if (origin === "settings") {
      const heading = document.querySelector<HTMLElement>("[data-testid='settings-computers-heading']");
      if (heading) {
        heading.focus();
        return;
      }
    }
    // Last resort: composer (only if it was genuinely the launching context).
    const composer = document.querySelector<HTMLElement>(".composer-surface textarea");
    composer?.focus();
  }

  // ── Unified close (Phase 4) ───────────────────────────────────────────────

  /** All close paths route through this function. */
  function requestClose(): void {
    // If the discard confirmation is open, close it instead of the sheet.
    if (showDiscardConfirm) {
      showDiscardConfirm = false;
      return;
    }

    if (stage === "provisioning") {
      // Once provisioning starts, close = Run in background.
      backgrounded = true;
      overlayHistory.closed("computer-setup");
      historyTracked = false;
      profileEditor.close();
      restoreFocus();
      return;
    }

    if (dirty && stage !== "provisioningFailed") {
      // Show the in-app discard confirmation (NOT window.confirm).
      showDiscardConfirm = true;
      if (phone) {
        overlayHistory.openedNested("cs-discard-confirm", () => {
          showDiscardConfirm = false;
        });
      }
      void tick().then(() => {
        panelEl?.querySelector<HTMLElement>("[data-testid='cs-discard-keep']")?.focus();
      });
      return;
    }

    overlayHistory.closed("computer-setup");
    historyTracked = false;
    profileEditor.close();
    restoreFocus();
  }

  /** Discard confirmation: keep editing. */
  function keepEditing(): void {
    showDiscardConfirm = false;
    // Focus stays in the setup panel — restore to the name field.
    void tick().then(() => {
      if (stage === "editing") {
        panelEl?.querySelector<HTMLInputElement>("#cs-edit-name")?.focus();
      } else {
        panelEl?.querySelector<HTMLInputElement>("#cs-name")?.focus();
      }
    });
  }

  /** Discard confirmation: discard changes. */
  function discardChanges(): void {
    showDiscardConfirm = false;
    profileEditor.clearDraft();
    overlayHistory.closed("computer-setup");
    historyTracked = false;
    profileEditor.close();
    restoreFocus();
  }

  function resetState(): void {
    stage = "connectionFields";
    nameTouched = false;
    rootTouched = false;
    operation = { kind: "idle" };
    testResult = null;
    testError = null;
    testSubStep = 0;
    selectedContainer = null;
    containerSearch = "";
    inspection = null;
    inspectionError = null;
    pendingRisks = [];
    riskError = null;
    provisioningPhase = 1;
    provisioningFailed = null;
    showTechnicalDetails = false;
    savedProfileId = null;
    backgrounded = false;
    editProfile = null;
    testedSnapshot = null;
    showDiscardConfirm = false;
    advancedOpen = false;
    customizeOpen = false;
  }

  async function loadEditProfile(profile: RemoteProfile): Promise<void> {
    try {
      const loaded = await provider.getProfile(profile.id);
      if (!loaded) return;
      editProfile = loaded;
      stage = "editing";
      nameTouched = true;
      // Set the draft + baseline via profileEditor.
      profileEditor.setEditDraft(loaded);
    } catch (err) {
      operation = {
        kind: "failed",
        error: normalizeError(err, "loadProfile"),
      };
    }
  }

  // ── SSH invalidation after a successful test ──────────────────────────────
  $effect(() => {
    const currentSsh = sshDestination;
    const currentPort = port;
    const currentEnv = execEnv;
    const snapshot = testedSnapshot;
    if (!snapshot) return;
    if (
      stage !== "choosingContainer" &&
      stage !== "exactName" &&
      stage !== "reviewingRisks" &&
      stage !== "provisioning" &&
      stage !== "provisioningFailed"
    )
      return;
    if (
      snapshot.sshDestination === currentSsh &&
      snapshot.port === currentPort &&
      snapshot.execEnv === currentEnv
    )
      return;
    // SSH value changed after a successful test — invalidate stale results.
    testResult = null;
    testError = null;
    selectedContainer = null;
    inspection = null;
    inspectionError = null;
    pendingRisks = [];
    riskError = null;
    testedSnapshot = null;
    stage = "connectionFields";
    if (!nameTouched && profileEditor.draft) {
      profileEditor.draft.name = "";
    }
  });

  // ── Draft field update helpers ────────────────────────────────────────────
  function updateDraft(field: keyof ComputerSetupDraft, value: string): void {
    if (!profileEditor.draft) return;
    (profileEditor.draft as Record<keyof ComputerSetupDraft, string>)[field] = value;
  }

  // ── SSH test ──────────────────────────────────────────────────────────────
  async function runTest(): Promise<void> {
    if (!sshDestination.trim()) return;
    operation = { kind: "testingSsh" };
    stage = "testingSsh";
    testError = null;
    testResult = null;
    testSubStep = 0;

    const stepTimer = setInterval(() => {
      testSubStep = Math.min(testSubStep + 1, execEnv === "host" ? 0 : 2);
    }, 400);

    try {
      if (execEnv === "host") {
        const result = await provider.testSshAndListContainers(sshDestination, Number(port) || 22);
        clearInterval(stepTimer);
        if (!result.sshOk) {
          stage = "sshFailed";
          testError = {
            title: "Can't reach the host",
            message: "Check the SSH destination and try again.",
          };
          operation = { kind: "idle" };
          return;
        }
        testedSnapshot = { sshDestination, port, execEnv: "host" };
        if (!nameTouched && profileEditor.draft) {
          profileEditor.draft.name = humanizeSshHost(sshDestination);
        }
        const profile = buildHostProfile();
        await saveAndStore(profile, true);
        return;
      }
      const result = await provider.testSshAndListContainers(sshDestination, Number(port) || 22);
      clearInterval(stepTimer);
      testResult = result;
      if (!result.sshOk) {
        stage = "sshFailed";
        testError = {
          title: "Can't reach the host",
          message: "Check the SSH destination and try again.",
        };
        operation = { kind: "idle" };
        return;
      }
      testedSnapshot = { sshDestination, port, execEnv: "docker" };
      stage = "choosingContainer";
      operation = { kind: "idle" };
    } catch (err) {
      clearInterval(stepTimer);
      stage = "sshFailed";
      const e = err as Error;
      testError = {
        title: e.message.includes("not available")
          ? "Container commands unavailable"
          : "SSH authentication failed",
        message: e.message,
      };
      operation = { kind: "idle" };
    }
  }

  function retryTest(): void {
    stage = "connectionFields";
    testError = null;
  }

  function editSshFields(): void {
    stage = "connectionFields";
    testError = null;
  }

  // ── Container selection ──────────────────────────────────────────────────
  function selectContainer(c: ContainerSummary): void {
    selectedContainer = c;
    if (!nameTouched && profileEditor.draft) {
      profileEditor.draft.name = humanizeContainerName(c.name);
    }
    void fetchInspection(c.name);
  }

  async function fetchInspection(cn: string): Promise<void> {
    inspectionError = null;
    operation = { kind: "inspectingContainer" };
    try {
      const insp = await provider.inspectContainer(sshDestination, Number(port) || 22, cn);
      inspection = insp;
      if (profileEditor.draft) {
        profileEditor.draft.containerUser = insp.configuredUser || insp.resolvedUser;
        if (!rootTouched) {
          profileEditor.draft.pantokenRoot = insp.pantokenRootSuggestion;
        }
      }
      operation = { kind: "idle" };
    } catch (err) {
      inspection = null;
      inspectionError = (err as Error).message;
      operation = {
        kind: "failed",
        error: normalizeError(err, "inspectContainer"),
      };
    }
  }

  function useExactName(): void {
    stage = "exactName";
    selectedContainer = null;
  }

  function backToPicker(): void {
    stage = "choosingContainer";
    updateDraft("containerName", "");
  }

  async function saveExactNameLater(): Promise<void> {
    const profile = buildProfile(containerName);
    await saveAndStore(profile, false);
  }

  // ── Use this container ────────────────────────────────────────────────────
  async function useThisContainer(): Promise<void> {
    const cn = selectedContainer?.name ?? containerName;
    if (!cn) return;

    if (!inspection && !inspectionError) {
      await fetchInspection(cn);
    }

    const profile = buildProfile(cn);
    await saveAndStore(profile, true);
  }

  function buildProfile(cn: string): RemoteProfile {
    const id = editProfile?.id ?? `docker-${Date.now()}`;
    const d = profileEditor.draft;
    return {
      id,
      label: name || humanizeContainerName(cn),
      sshDestination,
      port: Number(port) || 22,
      polytokenPolicy,
      remoteRootOverride: remoteRootOverride || undefined,
      serverPath: serverPath || undefined,
      xdgMode,
      executionTarget: {
        kind: "dockerContainer",
        containerName: cn,
        user: containerUser || "root",
        workdir: containerWorkdir || undefined,
        pantokenRoot: pantokenRoot || suggestPantokenRoot("/root"),
      },
      riskAcknowledgements: editProfile?.riskAcknowledgements ?? {},
    };
  }

  function buildHostProfile(): RemoteProfile {
    const id = editProfile?.id ?? `host-${Date.now()}`;
    return {
      id,
      label: name || humanizeSshHost(sshDestination),
      sshDestination,
      port: Number(port) || 22,
      polytokenPolicy,
      remoteRootOverride: remoteRootOverride || undefined,
      serverPath: serverPath || undefined,
      xdgMode,
      executionTarget: { kind: "host" },
      riskAcknowledgements: editProfile?.riskAcknowledgements ?? {},
    };
  }

  async function saveAndStore(profile: RemoteProfile, startProvisioning: boolean): Promise<void> {
    operation = { kind: "savingProfile" };
    try {
      const saved = await provider.addProfile(profile);
      savedProfileId = saved.id;
      await coordinator.refreshHosts();
      await coordinator.loadProfiles();

      if (startProvisioning) {
        stage = "provisioning";
        provisioningPhase = 1;
        operation = { kind: "connecting" };
        try {
          const connectResult = await coordinator.connectHost(saved.id);
          if (!connectResult.ok) {
            // Coordinator caught the provider error and returned a failure
            // result. The profile was saved — this is a partial success.
            provisioningFailed = {
              title: "Computer saved but not connected",
              message: connectResult.failure.label,
              detail: connectResult.failure.detail,
              savedButNotConnected: true,
            };
            stage = "provisioningFailed";
            operation = { kind: "idle" };
            console.error(
              `[ComputerSetupSheet] connect failed (profile saved): ${redactSshDestination(sshDestination).host}`,
              connectResult.failure,
            );
            return;
          }
          const hosts = await provider.listHosts();
          const host = hosts.find((h) => h.id === saved.id);
          if (host?.state === "awaitingAcknowledgement" && host.pendingRisks) {
            const allRisks = host.pendingRisks;
            const neededKinds = new Set(
              risksNeedingAcknowledgement(
                editProfile?.riskAcknowledgements ?? saved.riskAcknowledgements ?? {},
                {
                  containerId: inspection?.containerId ?? "",
                  pantokenRoot,
                  backingKey: backingLine,
                  hasSocketMount,
                  socketMountKey: inspection ? findSocketMount(inspection.mounts)?.source : undefined,
                },
              ),
            );
            pendingRisks = allRisks.filter((r) => neededKinds.has(r.kind));
            if (pendingRisks.length > 0) {
              stage = "reviewingRisks";
              operation = { kind: "idle" };
            } else {
              operation = { kind: "acknowledgingRisks" };
              for (const risk of allRisks) {
                await provider.acknowledgeRisk(savedProfileId!, risk.id, risk.fingerprint);
              }
              await provider.resumeConnection(savedProfileId!);
              await coordinator.refreshHosts();
              const hosts2 = await provider.listHosts();
              const host2 = hosts2.find((h) => h.id === savedProfileId);
              if (host2?.state === "ready") {
                provisioningPhase = 4;
                operation = { kind: "idle" };
                onComplete();
              } else {
                stage = "provisioning";
                provisioningPhase = 2;
                operation = { kind: "idle" };
              }
            }
          } else if (host?.state === "failed") {
            provisioningFailed = {
              title: host.failureLabel ?? "Connection failed",
              message: host.failureLabel ?? "Connection failed",
              detail: host.failureDetail,
            };
            stage = "provisioningFailed";
            operation = { kind: "idle" };
          } else if (host?.state === "ready") {
            provisioningPhase = 4;
            operation = { kind: "idle" };
            onComplete();
          }
        } catch (err) {
          // Connect failure — the profile was saved successfully.
          // This is a partial success, not a save failure.
          provisioningFailed = {
            title: "Computer saved but not connected",
            message: (err as Error)?.message ?? "Connection failed",
            detail: err instanceof Error
              ? (err.cause ? String(err.cause) : err.stack ?? err.toString())
              : typeof err === "string" ? err : JSON.stringify(err, null, 2),
            savedButNotConnected: true,
          };
          stage = "provisioningFailed";
          operation = { kind: "idle" };
          console.error(
            `[ComputerSetupSheet] connect failed (profile saved): ${redactSshDestination(sshDestination).host}`,
            err,
          );
        }
      } else {
        // Saved without provisioning — clear draft and close.
        profileEditor.clearDraft();
        overlayHistory.closed("computer-setup");
        historyTracked = false;
        profileEditor.close();
        restoreFocus();
        operation = { kind: "idle" };
      }
    } catch (err) {
      // Save failure — keep the draft intact, show error.
      operation = {
        kind: "failed",
        error: normalizeError(err, "save"),
      };
      console.error(
        `[ComputerSetupSheet] save failed: ${redactSshDestination(sshDestination).host}`,
        err,
      );
      stage = "connectionFields";
    }
  }

  // ── Risk acknowledgement ──────────────────────────────────────────────────
  async function acceptRisks(): Promise<void> {
    riskError = null;
    if (!savedProfileId) return;
    operation = { kind: "acknowledgingRisks" };
    try {
      for (const risk of pendingRisks) {
        await provider.acknowledgeRisk(savedProfileId, risk.id, risk.fingerprint);
      }
      await provider.resumeConnection(savedProfileId);
      await coordinator.refreshHosts();
      const hosts = await provider.listHosts();
      const host = hosts.find((h) => h.id === savedProfileId);
      if (host?.state === "ready") {
        provisioningPhase = 4;
        operation = { kind: "idle" };
        onComplete();
      } else if (host?.state === "failed") {
        provisioningFailed = {
          title: host.failureLabel ?? "Provisioning failed",
          message: host.failureLabel ?? "Provisioning failed",
          detail: host.failureDetail,
        };
        stage = "provisioningFailed";
        operation = { kind: "idle" };
      } else {
        stage = "provisioning";
        provisioningPhase = 2;
        operation = { kind: "idle" };
      }
    } catch (err) {
      riskError = (err as Error).message;
      operation = {
        kind: "failed",
        error: normalizeError(err, "acknowledgeRisk"),
      };
      console.error(
        `[ComputerSetupSheet] acknowledgeRisk failed: ${redactSshDestination(sshDestination).host}`,
        err,
      );
    }
  }

  function chooseAnotherPath(): void {
    stage = "choosingContainer";
    customizeOpen = true;
    pendingRisks = [];
  }

  // ── Provisioning ───────────────────────────────────────────────────────────
  async function cancelSetup(): Promise<void> {
    if (!safelyCancellable) return;
    if (savedProfileId) {
      try {
        await provider.cancelConnection(savedProfileId);
        await coordinator.refreshHosts();
      } catch (err) {
        console.error("[ComputerSetupSheet] cancelConnection failed:", err);
      }
    }
    requestClose();
  }

  function onComplete(): void {
    if (!backgrounded && savedProfileId) {
      void coordinator.selectHost(savedProfileId);
    }
    // Successful save — clear the draft.
    profileEditor.clearDraft();
    requestClose();
  }

  // ── Retry connect (for saved-but-not-connected) ───────────────────────────
  async function retryConnect(): Promise<void> {
    if (!savedProfileId) return;
    stage = "provisioning";
    provisioningFailed = null;
    operation = { kind: "connecting" };
    try {
      await coordinator.connectHost(savedProfileId);
      await coordinator.refreshHosts();
      const hosts = await provider.listHosts();
      const host = hosts.find((h) => h.id === savedProfileId);
      if (host?.state === "ready") {
        provisioningPhase = 4;
        operation = { kind: "idle" };
        onComplete();
      } else if (host?.state === "failed") {
        provisioningFailed = {
          title: host.failureLabel ?? "Connection failed",
          message: host.failureLabel ?? "Connection failed",
          detail: host.failureDetail,
        };
        stage = "provisioningFailed";
        operation = { kind: "idle" };
      }
    } catch (err) {
      provisioningFailed = {
        title: "Connection failed",
        message: (err as Error)?.message ?? "Connection failed",
        detail: err instanceof Error
          ? (err.cause ? String(err.cause) : err.stack ?? err.toString())
          : typeof err === "string" ? err : JSON.stringify(err, null, 2),
        savedButNotConnected: true,
      };
      stage = "provisioningFailed";
      operation = { kind: "idle" };
      console.error(
        `[ComputerSetupSheet] retry connect failed: ${redactSshDestination(sshDestination).host}`,
        err,
      );
    }
  }

  // ── Edit dialog actions ───────────────────────────────────────────────────
  async function reconnectNow(): Promise<void> {
    if (!editProfile) return;
    const validationError = validateProfileDraft(toValidationDraft(profileEditor.draft!));
    if (validationError) {
      operation = {
        kind: "failed",
        error: { summary: validationError, operation: "validate", retryable: false },
      };
      return;
    }
    operation = { kind: "updatingProfile" };
    const updated = buildEditProfile();
    try {
      await provider.updateProfile(updated);
      await coordinator.refreshHosts();
      if (editProfile) {
        operation = { kind: "connecting" };
        await coordinator.connectHost(editProfile.id);
      }
      profileEditor.clearDraft();
      requestClose();
    } catch (err) {
      operation = {
        kind: "failed",
        error: normalizeError(err, "update"),
      };
      console.error(
        `[ComputerSetupSheet] update failed: ${redactSshDestination(sshDestination).host}`,
        err,
      );
    }
  }

  async function reconnectLater(): Promise<void> {
    if (!editProfile) return;
    const validationError = validateProfileDraft(toValidationDraft(profileEditor.draft!));
    if (validationError) {
      operation = {
        kind: "failed",
        error: { summary: validationError, operation: "validate", retryable: false },
      };
      return;
    }
    operation = { kind: "updatingProfile" };
    const updated = buildEditProfile();
    try {
      await provider.updateProfile(updated);
      await coordinator.refreshHosts();
      profileEditor.clearDraft();
      requestClose();
    } catch (err) {
      operation = {
        kind: "failed",
        error: normalizeError(err, "update"),
      };
      console.error(
        `[ComputerSetupSheet] update failed: ${redactSshDestination(sshDestination).host}`,
        err,
      );
    }
  }

  function buildEditProfile(): RemoteProfile {
    if (!editProfile) return buildProfile(containerName);
    const d = profileEditor.draft;
    if (!d) return { ...editProfile };
    return {
      ...editProfile,
      label: d.name,
      sshDestination: d.sshDestination,
      port: Number(d.port) || 22,
      polytokenPolicy: d.polytokenPolicy,
      remoteRootOverride: d.remoteRootOverride || undefined,
      serverPath: d.serverPath || undefined,
      xdgMode: d.xdgMode,
      executionTarget: editProfile.executionTarget.kind === "dockerContainer"
        ? {
            kind: "dockerContainer",
            containerName: d.containerName || editProfile.executionTarget.containerName,
            user: d.containerUser || editProfile.executionTarget.user,
            workdir: d.containerWorkdir || undefined,
            pantokenRoot: d.pantokenRoot || editProfile.executionTarget.pantokenRoot,
          }
        : { kind: "host" },
    };
  }

  // ── Keyboard (capture-phase hotkey ownership + focus trap) ────────────────
  $effect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      // If the discard confirmation is open, handle its keyboard.
      if (showDiscardConfirm) {
        if (e.key === "Escape") {
          e.preventDefault();
          keepEditing();
          return;
        }
        // Focus trap within the confirmation.
        if (e.key === "Tab") {
          trapFocus(e, "[data-testid='cs-discard-confirm']");
        }
        return;
      }

      // Escape closes the sheet (or goes back a stage on phone).
      if (e.key === "Escape") {
        e.preventDefault();
        if (phone && stage !== "connectionFields" && stage !== "editing") {
          if (stage === "exactName") backToPicker();
          else if (stage === "choosingContainer") stage = "connectionFields";
          else requestClose();
        } else {
          requestClose();
        }
        return;
      }

      // Focus trap within the panel.
      if (e.key === "Tab") {
        trapFocus(e, ".panel");
        return;
      }

      // While the sheet is open, absorb printable keystrokes and Enter so they
      // never reach the composer's type-to-focus / Enter-to-send handler.
      if (e.key.length === 1 || e.key === "Enter") {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          return;
        }
        e.preventDefault();
        panelEl?.querySelector<HTMLInputElement>("#cs-name")?.focus();
      }
    }

    function trapFocus(e: KeyboardEvent, containerSelector: string): void {
      const container = document.querySelector<HTMLElement>(containerSelector);
      if (!container) return;
      const focusables = container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function onNameInput(e: Event): void {
    updateDraft("name", (e.target as HTMLInputElement).value);
    nameTouched = true;
  }

  function onRootInput(e: Event): void {
    updateDraft("pantokenRoot", (e.target as HTMLInputElement).value);
    rootTouched = true;
  }

  function onContainerUserInput(e: Event): void {
    const val = (e.target as HTMLInputElement).value;
    updateDraft("containerUser", val);
    if (!rootTouched && inspection) {
      const newHome = val === "root" ? "/root" : `/home/${val}`;
      updateDraft("pantokenRoot", suggestPantokenRoot(newHome));
    }
  }

  const backingLine = $derived(inspection ? formatBacking(inspection) : "");
  const hasSocketMount = $derived(inspection ? Boolean(findSocketMount(inspection.mounts)) : false);

  // Watch for provisioning phase changes from the dev provider.
  $effect(() => {
    if (stage !== "provisioning" || !savedProfileId) return;
    const summary = coordinator.summaries.find((s) => s.descriptor.id === savedProfileId);
    if (!summary) return;
    const desc = summary.descriptor;
    if (desc.state === "ready" && provisioningPhase < 4) {
      provisioningPhase = 4;
      onComplete();
    } else if (desc.state === "failed") {
      provisioningFailed = {
        title: desc.failureLabel ?? "Provisioning failed",
        message: desc.failureLabel ?? "Provisioning failed",
        detail: desc.failureDetail,
      };
      stage = "provisioningFailed";
    } else if (desc.state === "provisioning") {
      if (desc.preflightPhase) {
        provisioningPhase = 2;
      }
    }
  });

  const dialogTitle = $derived(
    stage === "editing" ? "Edit computer" :
    stage === "provisioning" || stage === "provisioningFailed" ? `Connecting to ${name || "Docker target"}` :
    stage === "reviewingRisks" ? "Review risks" :
    "Add computer",
  );

  const closeLabel = $derived(
    stage === "provisioning" ? "Run in background" : "Close",
  );

  const footerRight = $derived.by(() => {
    if (stage === "choosingContainer") {
      return `SSH: ${sshDestination}:${port} · Docker container`;
    }
    if (stage === "reviewingRisks") {
      return `${pendingRisks.length} risk${pendingRisks.length === 1 ? "" : "s"} detected · one click to accept all`;
    }
    if (stage === "provisioning") {
      return `Phase ${provisioningPhase} of 4 · ${PHASE_LABELS[provisioningPhase - 1]}`;
    }
    if (stage === "provisioningFailed") {
      return `Failed at phase ${provisioningPhase} of 4 · ${PHASE_LABELS[provisioningPhase - 1]}`;
    }
    return "";
  });

  // Testing sub-steps: Host shows only SSH connection; Docker shows all three.
  const testingSubSteps = $derived(
    execEnv === "host"
      ? [`Connecting to ${sshHost} via SSH…`]
      : [
          `Connecting to ${sshHost} via SSH…`,
          "Checking Docker access…",
          "Listing running containers…",
        ],
  );

  const policyOptions = [
    { value: "requireExisting" as const, label: "Require existing" },
    { value: "offerInstall" as const, label: "Offer install" },
  ];

  // Error from the operation state machine (Phase 7)
  const opError = $derived(
    operation.kind === "failed" ? operation.error : null,
  );
</script>

{#if open}
  <div class="scrim" onclick={() => requestClose()} role="presentation"></div>
  <div
    bind:this={panelEl}
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label={dialogTitle}
    data-testid="computer-setup-panel"
    tabindex="-1"
  >
    <header class="phead">
      {#if phone && stage !== "connectionFields" && stage !== "editing"}
        <button class="mobile-back" type="button" aria-label="Back" onclick={() => {
          if (stage === "exactName") backToPicker();
          else if (stage === "choosingContainer") stage = "connectionFields";
          else if (stage === "reviewingRisks") stage = "choosingContainer";
          else requestClose();
        }}>
          <span class="back-chevron"><Chevron size={14} /></span>
          <span>Back</span>
        </button>
      {/if}
      <h2>{dialogTitle}</h2>
      <button class="close-btn" onclick={() => requestClose()} data-testid="computer-setup-close">
        {closeLabel}
      </button>
    </header>

    <div class="body" inert={showDiscardConfirm}>
      {#if profileEditor.loadingProfile}
        <div class="loading-state" data-testid="cs-loading">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading…</span>
        </div>
      {:else if showConnectionFields}
        <div class="field">
          <label for="cs-name">Name <span class="opt">(optional)</span></label>
          <input
            id="cs-name"
            type="text"
            placeholder="e.g. Work API Dev"
            value={name}
            oninput={onNameInput}
            data-testid="cs-name-input"
          />
        </div>

        <div class="field">
          <label for="cs-ssh">SSH destination</label>
          <div class="ssh-row">
            <input
              id="cs-ssh"
              type="text"
              placeholder="user@host or SSH config alias"
              value={sshDestination}
              oninput={(e) => updateDraft("sshDestination", (e.target as HTMLInputElement).value)}
              data-testid="cs-ssh-input"
            />
            <input
              type="number"
              placeholder="Port"
              value={port}
              min={1}
              max={65535}
              oninput={(e) => updateDraft("port", (e.target as HTMLInputElement).value)}
              class="port-input"
              data-testid="cs-port-input"
            />
          </div>
          <p class="hint">Pantoken uses your existing SSH config, agent, and keychain. No passwords stored.</p>
        </div>

        <div class="field">
          <label>Execution environment</label>
          <SegmentedControl
            ariaLabel="Execution environment"
            value={execEnv}
            onchange={(v: "host" | "docker") => updateDraft("executionTarget", v)}
            options={[
              { value: "host", label: "Host", testid: "cs-env-host" },
              { value: "docker", label: "Docker container", testid: "cs-env-docker", title: supportsDocker ? "Docker container" : "Docker targets require the Pantoken desktop app", disabled: !supportsDocker },
            ]}
          />
          {#if !supportsDocker && execEnv === "docker"}
            <p class="hint warn" data-testid="cs-docker-degraded">Docker targets require the Pantoken desktop app</p>
          {:else}
            <p class="hint">Run the agent directly on the SSH host, or inside a Docker container on that host.</p>
          {/if}
        </div>

        {#if stage === "testingSsh"}
          <div class="testing-box" data-testid="cs-testing">
            <div class="testing-spinner">
              <span class="spinner" aria-hidden="true"></span>
              <span>{execEnv === "host" ? "Testing SSH…" : "Testing SSH & finding containers…"}</span>
            </div>
            <div class="sub-steps">
              {#each testingSubSteps as step, i}
                <div class="sub-step" class:done={testSubStep > i} class:active={testSubStep === i}>
                  {#if testSubStep > i}<span class="check">✓</span>{:else if testSubStep === i}<span class="spinner-sm" aria-hidden="true"></span>{:else}<span class="dot">•</span>{/if}
                  {step}
                </div>
              {/each}
            </div>
          </div>
        {:else if stage !== "choosingContainer" && stage !== "exactName"}
          <Button
            variant="primary"
            block
            disabled={!sshDestination.trim() || (execEnv === "docker" && !supportsDocker) || operation.kind === "testingSsh"}
            onclick={() => void runTest()}
            data-testid="cs-test-ssh"
          >
            {primaryLabel}
          </Button>
        {/if}

        {#if stage === "sshFailed" && testError}
          <div class="error-box" data-testid="cs-ssh-error">
            <div class="error-title">⚠ {testError.title}</div>
            <div class="error-msg">{testError.message}</div>
            <div class="error-actions">
              <Button variant="primary" onclick={() => void runTest()}>Retry</Button>
              <Button onclick={editSshFields}>Edit</Button>
            </div>
          </div>
        {/if}

        <!-- Advanced disclosure -->
        <button class="disclosure" onclick={() => advancedOpen = !advancedOpen} aria-expanded={advancedOpen}>
          {advancedOpen ? "▾" : "▸"} Advanced
        </button>
        {#if advancedOpen}
          <div class="advanced-body">
            <div class="field">
              <div class="field-label">Polytoken policy</div>
              <SegmentedControl
                ariaLabel="Polytoken policy"
                options={policyOptions}
                value={polytokenPolicy}
                onchange={(v: PolytokenPolicy) => updateDraft("polytokenPolicy", v)}
              />
            </div>
            <div class="field">
              <label for="cs-root-override">Remote-root override <span class="opt">(optional)</span></label>
              <input id="cs-root-override" type="text" placeholder="/custom/pantoken-root" value={remoteRootOverride} oninput={(e) => updateDraft("remoteRootOverride", (e.target as HTMLInputElement).value)} data-testid="cs-root-override-input" />
            </div>
            <div class="field">
              <label for="cs-server-path">Server binary path</label>
              <input id="cs-server-path" type="text" placeholder="Default" value={serverPath} oninput={(e) => updateDraft("serverPath", (e.target as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label>XDG mode</label>
              <SegmentedControl
                ariaLabel="XDG mode"
                value={xdgMode}
                onchange={(v: "isolated" | "shared") => updateDraft("xdgMode", v)}
                options={[
                  { value: "isolated", label: "Isolated", title: "Stores config, sessions, and cache in isolated directories." },
                  { value: "shared", label: "Shared", title: "Shares config, sessions, and cache with your existing polytoken install." },
                ]}
              />
            </div>
          </div>
        {/if}
      {/if}

      <!-- ── Container picker ─────────────────────────────────────────── -->
      {#if stage === "choosingContainer" && testResult}
        <div class="ssh-summary" data-testid="cs-ssh-summary">
          ● SSH connected to {sshHost} · Docker permission: {testResult.dockerPermission}
        </div>

        <div class="section-label">Running containers ({containers.length})</div>

        {#if showSearch}
          <input
            type="text"
            class="container-search"
            placeholder="🔍 Search containers…"
            value={containerSearch}
            oninput={(e) => containerSearch = (e.target as HTMLInputElement).value}
            data-testid="cs-container-search"
          />
        {/if}

        <div class="container-list" role="listbox" aria-label="Running containers">
          {#each filteredContainers as c (c.name)}
            <button
              class="container-row"
              class:selected={selectedContainer?.name === c.name}
              role="option"
              aria-selected={selectedContainer?.name === c.name}
              data-testid={`cs-container-${c.name}`}
              onclick={() => selectContainer(c)}
            >
              <span class="ctr-glyph">▣</span>
              <span class="ctr-info">
                <span class="ctr-name">{c.name}</span>
                <span class="ctr-meta">
                  <span class="ctr-image">{c.image}</span>
                  ·
                  <span>{c.configuredUser || "Image default"}</span>
                  {#if c.composeProject}<span class="ctr-compose">compose: {c.composeProject}/{c.composeService}</span>{/if}
                </span>
              </span>
              <span class="ctr-state">{c.state}</span>
            </button>
          {/each}
        </div>

        <button class="link-btn" onclick={useExactName} data-testid="cs-exact-name-link">
          Enter exact container name instead
        </button>

        {#if selectedContainer}
          <button class="disclosure" onclick={() => customizeOpen = !customizeOpen} aria-expanded={customizeOpen} data-testid="cs-customize-toggle">
            {customizeOpen ? "▾" : "▸"} Customize target
          </button>
          {#if customizeOpen}
            <div class="customize-body" data-testid="cs-customize">
              {#if inspectionError}
                <p class="hint warn">Container inspection unavailable: {inspectionError}</p>
              {:else if inspection}
                <div class="field">
                  <label for="cs-user">Container user</label>
                  <input id="cs-user" type="text" value={containerUser} oninput={onContainerUserInput} data-testid="cs-user-input" />
                  <p class="resolved-id">{containerUser} · UID {inspection.resolvedUid}</p>
                  <p class="hint">Always persisted explicitly. Pre-filled from the container's configured user.</p>
                </div>
                <div class="field">
                  <label for="cs-root">Pantoken root</label>
                  <input id="cs-root" type="text" value={pantokenRoot} oninput={onRootInput} data-testid="cs-root-input" />
                  <p class="hint">Default = selected user's home + /.local/share/pantoken. Never persists ~.</p>
                  {#if backingLine}<p class="backing-line" data-testid="cs-backing">{backingLine}</p>{/if}
                </div>
                <div class="field">
                  <label for="cs-workdir">Workdir <span class="opt">(optional)</span></label>
                  <input id="cs-workdir" type="text" placeholder="/workspace" value={containerWorkdir} oninput={(e) => updateDraft("containerWorkdir", (e.target as HTMLInputElement).value)} data-testid="cs-workdir-input" />
                </div>
              {:else}
                <p class="hint">Loading inspection…</p>
              {/if}
            </div>
          {/if}
          <Button variant="primary" block disabled={operation.kind === "inspectingContainer" || operation.kind === "savingProfile" || operation.kind === "connecting"} onclick={() => void useThisContainer()} data-testid="cs-use-container">
            Use this container
          </Button>
        {/if}
      {/if}

      <!-- ── Exact-name fallback ─────────────────────────────────────────── -->
      {#if stage === "exactName"}
        <button class="link-btn" onclick={backToPicker} data-testid="cs-back-to-list">
          ‹ Back to container list
        </button>
        <div class="field">
          <label for="cs-exact">Exact container name</label>
          <input id="cs-exact" type="text" value={containerName} oninput={(e) => updateDraft("containerName", (e.target as HTMLInputElement).value)} data-testid="cs-exact-input" />
          <p class="hint">The saved selector is always the exact container name. Discovery is only a convenience.</p>
        </div>
        <div class="warning-box" data-testid="cs-not-running-warning">
          <div class="warning-title">⚠ Container not currently running</div>
          <div class="warning-body">
            This container is not running right now. You can still save this profile — it will appear
            as a disconnected computer in Container not running state. It cannot provision until the
            container exists and runs. Start or recreate the container outside Pantoken, then retry.
          </div>
        </div>
        <Button variant="primary" block disabled={!containerName.trim() || operation.kind === "savingProfile"} onclick={() => void saveExactNameLater()} data-testid="cs-save-later">
          Save & connect later
        </Button>
      {/if}

      <!-- ── Review risks panel ───────────────────────────────────────────── -->
      {#if stage === "reviewingRisks"}
        <div class="risks-panel" data-testid="cs-risks-panel">
          <h3>Review risks before connecting</h3>
          <p class="risks-sub">
            The following risks were detected for {selectedContainer?.name ?? containerName} via {sshHost}.
            Review each item, then accept to continue.
          </p>
          {#each pendingRisks as risk (risk.id)}
            <div class="risk-card" data-testid={`cs-risk-${risk.kind}`}>
              <div class="risk-title">⚠ {RISK_BODIES[risk.kind].title}</div>
              <div class="risk-body">{RISK_BODIES[risk.kind].body}</div>
            </div>
          {/each}
          {#if riskError}
            <div class="error-box"><div class="error-msg">{riskError}</div></div>
          {/if}
          {#if isEphemeralOnly}
            <Button variant="primary" block onclick={chooseAnotherPath} data-testid="cs-choose-path">
              Choose another path
            </Button>
            <Button block disabled={operation.kind === "acknowledgingRisks"} onclick={() => void acceptRisks()} data-testid="cs-accept-risks">
              Accept risks & continue
            </Button>
          {:else}
            <Button variant="primary" block disabled={operation.kind === "acknowledgingRisks"} onclick={() => void acceptRisks()} data-testid="cs-accept-risks">
              Accept risks & continue
            </Button>
          {/if}
        </div>
      {/if}

      <!-- ── Provisioning ────────────────────────────────────────────────── -->
      {#if stage === "provisioning" || stage === "provisioningFailed"}
        <div class="provisioning" data-testid="cs-provisioning">
          <div class="prov-subtitle">Setting up Docker target</div>
          <div class="prov-subline">{selectedContainer?.name ?? containerName} via {sshHost}</div>

          <div class="phase-list">
            {#each PHASE_LABELS as label, i}
              {@const phaseNum = i + 1}
              {@const isCompleted = stage === "provisioning" && provisioningPhase > phaseNum}
              {@const isActive = stage === "provisioning" && provisioningPhase === phaseNum}
              {@const isFailed = stage === "provisioningFailed" && provisioningPhase === phaseNum}
              {@const isPending = !isCompleted && !isActive && !isFailed}
              <div class="phase" class:completed={isCompleted} class:active={isActive} class:failed={isFailed} class:pending={isPending}>
                <span class="phase-marker" aria-hidden="true">
                  {#if isCompleted}✓{:else if isFailed}✕{:else}{phaseNum}{/if}
                </span>
                <span class="phase-label">{label}</span>
                {#if isCompleted && inspection}
                  <span class="phase-detail">
                    {inspection.name} · {containerUser} (UID {inspection.resolvedUid}) · {inspection.os}/{inspection.arch} · {backingLine}
                  </span>
                {:else if isActive}
                  <span class="phase-detail">
                    {#if phaseNum === 1}SSH connected · Docker CLI available{:else if phaseNum === 2}Locating container by name · inspecting identity…{:else if phaseNum === 3}Checking compatibility{:else if phaseNum === 4}Starting runtime{/if}
                  </span>
                {/if}
              </div>
            {/each}
          </div>

          {#if stage === "provisioningFailed" && provisioningFailed}
            <div class="error-box" data-testid="cs-prov-failure">
              <div class="error-title">✕ {provisioningFailed.title}</div>
              <div class="error-msg">{provisioningFailed.message}</div>
              <div class="error-actions">
                {#if provisioningFailed.savedButNotConnected}
                  <Button variant="primary" onclick={() => void retryConnect()} data-testid="cs-prov-retry">Retry connect</Button>
                {:else}
                  <Button variant="primary" onclick={() => {
                    stage = "provisioning";
                    provisioningFailed = null;
                    void coordinator.connectHost(savedProfileId!);
                  }} data-testid="cs-prov-retry">Retry</Button>
                {/if}
                <Button onclick={() => requestClose()}>Edit</Button>
              </div>
              {#if provisioningFailed.detail}
                <button class="disclosure" onclick={() => showTechnicalDetails = !showTechnicalDetails} aria-expanded={showTechnicalDetails}>
                  {showTechnicalDetails ? "▾" : "▸"} Show technical details
                </button>
                {#if showTechnicalDetails}
                  <div class="tech-details-wrapper">
                    <pre class="tech-details">{provisioningFailed.detail}</pre>
                    <button type="button" class="error-copy" onclick={() => navigator.clipboard.writeText(provisioningFailed?.detail ?? "")}>Copy</button>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Edit dialog ─────────────────────────────────────────────────── -->
      {#if stage === "editing" && editProfile}
        <div class="field">
          <label for="cs-edit-name">Name</label>
          <input id="cs-edit-name" type="text" value={name} oninput={onNameInput} data-testid="cs-edit-name" />
        </div>
        <div class="field">
          <label for="cs-edit-ssh">SSH destination</label>
          <div class="ssh-row">
            <input id="cs-edit-ssh" type="text" value={sshDestination} oninput={(e) => updateDraft("sshDestination", (e.target as HTMLInputElement).value)} data-testid="cs-edit-ssh" />
            <input type="number" value={port} oninput={(e) => updateDraft("port", (e.target as HTMLInputElement).value)} class="port-input" />
          </div>
        </div>
        <div class="field">
          <label>Execution environment</label>
          <div class="readonly-field" data-testid="cs-edit-exec-env">
            🔒 {execEnv === "docker" ? "Docker container" : "Host"} — immutable after creation
          </div>
          <p class="hint">To switch to Host execution, add a new computer profile.</p>
        </div>
        {#if editProfile.executionTarget.kind === "dockerContainer"}
          <div class="docker-target-section" data-testid="cs-edit-docker-target">
            <div class="section-label">Docker target</div>
            <div class="field">
              <label for="cs-edit-ctr">Container name</label>
              <input id="cs-edit-ctr" type="text" value={containerName} oninput={(e) => updateDraft("containerName", (e.target as HTMLInputElement).value)} data-testid="cs-edit-container-name" />
            </div>
            <div class="field">
              <label for="cs-edit-user">Container user</label>
              <input id="cs-edit-user" type="text" value={containerUser} oninput={onContainerUserInput} data-testid="cs-edit-user" />
              {#if inspection}<p class="resolved-id">{containerUser} · UID {inspection.resolvedUid}</p>{/if}
            </div>
            <div class="field">
              <label for="cs-edit-root">Pantoken root</label>
              <input id="cs-edit-root" type="text" value={pantokenRoot} oninput={onRootInput} data-testid="cs-edit-root" />
              {#if backingLine}<p class="backing-line">{backingLine}</p>{/if}
            </div>
            <div class="field">
              <label for="cs-edit-workdir">Workdir <span class="opt">(optional)</span></label>
              <input id="cs-edit-workdir" type="text" placeholder="/workspace" value={containerWorkdir} oninput={(e) => updateDraft("containerWorkdir", (e.target as HTMLInputElement).value)} data-testid="cs-edit-workdir" />
            </div>
          </div>
        {/if}
        <button class="disclosure" onclick={() => advancedOpen = !advancedOpen} aria-expanded={advancedOpen}>
          {advancedOpen ? "▾" : "▸"} Advanced
        </button>
        {#if advancedOpen}
          <div class="advanced-body">
            <div class="field">
              <div class="field-label">Polytoken policy</div>
              <SegmentedControl
                ariaLabel="Polytoken policy"
                options={policyOptions}
                value={polytokenPolicy}
                onchange={(v: PolytokenPolicy) => updateDraft("polytokenPolicy", v)}
              />
            </div>
            <div class="field">
              <label for="cs-edit-root-override">Remote-root override <span class="opt">(optional)</span></label>
              <input id="cs-edit-root-override" type="text" placeholder="/custom/pantoken-root" value={remoteRootOverride} oninput={(e) => updateDraft("remoteRootOverride", (e.target as HTMLInputElement).value)} data-testid="cs-edit-root-override" />
            </div>
            <div class="field">
              <label for="cs-edit-server">Server binary path</label>
              <input id="cs-edit-server" type="text" value={serverPath} oninput={(e) => updateDraft("serverPath", (e.target as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label>XDG mode</label>
              <SegmentedControl ariaLabel="XDG mode" value={xdgMode} onchange={(v: "isolated" | "shared") => updateDraft("xdgMode", v)} options={[{ value: "isolated", label: "Isolated", title: "Stores config, sessions, and cache in isolated directories." }, { value: "shared", label: "Shared", title: "Shares config, sessions, and cache with your existing polytoken install." }]} />
            </div>
          </div>
        {/if}
        <div class="reconnect-notice" data-testid="cs-reconnect-notice">
          {#if execEnv === "docker"}
            ⚠ Reconnection required. Changing container selection, user, or root saves a new profile and keeps the old connection live until you reconnect.
          {:else}
            Saving updates the profile. Reconnect to apply SSH/port changes.
          {/if}
        </div>
      {/if}

      <!-- ── Operation error block (Phase 7) ──────────────────────────────── -->
      {#if opError}
        <div class="error-block" role="alert" data-testid="cs-form-error">
          <p class="error-msg">{opError.summary}</p>
          {#if opError.detail}
            <details class="error-details">
              <summary>Show details</summary>
              <pre class="error-detail-text">{opError.detail}</pre>
              <button type="button" class="error-copy" onclick={() => navigator.clipboard.writeText(opError?.detail ?? "")}>Copy</button>
            </details>
          {/if}
        </div>
      {/if}
    </div>

    <!-- ── Discard confirmation dialog (Phase 4.3) ──────────────────────── -->
    {#if showDiscardConfirm}
      <div class="discard-overlay" data-testid="cs-discard-confirm" role="alertdialog" aria-modal="true" aria-label="Discard changes?">
        <div class="discard-card">
          <h3>Discard changes?</h3>
          <p>The unsaved computer setup will be lost.</p>
          <div class="discard-actions">
            <Button variant="primary" onclick={keepEditing} data-testid="cs-discard-keep">Keep editing</Button>
            <Button variant="danger" onclick={discardChanges} data-testid="cs-discard-discard">Discard changes</Button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Footer ───────────────────────────────────────────────────────── -->
    <footer class="pfoot">
      {#if stage === "provisioning" || stage === "provisioningFailed"}
        {#if safelyCancellable && stage === "provisioning"}
          <Button variant="danger" onclick={() => void cancelSetup()} data-testid="cs-cancel-setup">Cancel setup</Button>
        {/if}
      {:else if stage === "editing"}
        <Button disabled={operation.kind === "updatingProfile" || operation.kind === "connecting"} onclick={() => void reconnectLater()} data-testid="cs-reconnect-later">Reconnect later</Button>
        <Button variant="primary" disabled={operation.kind === "updatingProfile" || operation.kind === "connecting"} onclick={() => void reconnectNow()} data-testid="cs-reconnect-now">Reconnect now</Button>
      {:else if stage !== "reviewingRisks"}
        <Button onclick={requestClose} data-testid="cs-cancel-setup">Cancel setup</Button>
      {/if}
      {#if footerRight}
        <span class="footer-right">{footerRight}</span>
      {/if}
    </footer>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 60;
    animation: fade 0.15s ease;
  }
  .panel {
    position: fixed;
    z-index: 61;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(540px, 100%);
    max-height: 88dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    box-shadow: var(--shadow-pop);
    animation: rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .panel:focus { outline: none; }
  @media (min-width: 600px) {
    .panel {
      top: 50%;
      bottom: auto;
      transform: translate(-50%, -50%);
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .phead h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .close-btn {
    border: 0; background: none; color: var(--accent); cursor: pointer;
    font: inherit; font-size: 13px; font-weight: 500;
    min-height: 44px; min-width: 44px;
  }
  .mobile-back { display: none; }
  .body {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 4px 20px calc(20px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label, .field-label { font-size: 13px; font-weight: 500; color: var(--text); }
  .opt { font-weight: 400; color: var(--text-muted); }
  .field input, .container-search {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 9px 11px;
    font-size: 16px;
    background: var(--bg);
    color: var(--text);
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  .field input:focus, .container-search:focus { border-color: var(--accent); }
  .ssh-row { display: flex; gap: 8px; }
  .ssh-row input:first-child { flex: 1; min-width: 0; }
  .port-input { width: 80px; flex-shrink: 0; }
  .hint { font-size: 12px; color: var(--text-muted); line-height: 1.45; margin: 2px 0 0; }
  .hint.warn { color: var(--accent); }
  .loading-state {
    display: flex; align-items: center; gap: 8px;
    padding: 24px; justify-content: center;
    font-size: 14px; color: var(--text-muted);
  }
  .testing-box {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    background: var(--surface);
  }
  .testing-spinner { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); }
  .spinner, .spinner-sm {
    width: 14px; height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  .spinner-sm { width: 10px; height: 10px; border-width: 1.5px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sub-steps { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .sub-step { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
  .sub-step.active { color: var(--text); }
  .sub-step.done { color: var(--ok, var(--text-muted)); }
  .sub-step .check { color: var(--ok, var(--accent)); }
  .sub-step .dot { color: var(--text-faint); }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
    border-radius: var(--radius-sm);
    padding: 12px;
    background: var(--danger-soft, var(--surface));
  }
  .error-title { font-size: 13px; font-weight: 600; color: var(--danger); margin-bottom: 4px; }
  .error-msg { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .error-actions { display: flex; gap: 8px; margin-top: 8px; }
  .error-block {
    border: 1px solid var(--danger);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
  .error-block .error-msg { font-size: 13px; color: var(--danger); margin: 0; }
  .error-details { margin-top: 6px; }
  .error-details summary {
    font-size: 12px; color: var(--text-muted); cursor: pointer;
    min-height: 32px; display: flex; align-items: center;
  }
  .error-detail-text {
    font-size: 11px; font-family: var(--font-mono, monospace);
    color: var(--text-muted); margin: 6px 0 0; white-space: pre-wrap;
    word-break: break-all; max-height: 200px; overflow-y: auto;
    background: var(--surface-sunken); padding: 8px; border-radius: 4px;
  }
  .error-copy {
    font: inherit; font-size: 11px; color: var(--accent);
    background: none; border: 0; cursor: pointer; padding: 4px 0;
    min-height: 32px;
  }
  .error-copy:hover { color: var(--text); }
  .ssh-summary {
    font-size: 12px; color: var(--text-muted);
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .section-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-faint); margin-top: 4px;
  }
  .container-list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; }
  .container-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px; border-radius: var(--radius-sm);
    border: 1px solid transparent; background: none;
    cursor: pointer; text-align: left; width: 100%;
    font: inherit;
  }
  .container-row:hover { background: var(--surface-hover, var(--surface)); }
  .container-row.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .ctr-glyph { color: var(--accent); font-size: 16px; flex-shrink: 0; }
  .ctr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .ctr-name { font-weight: 600; font-size: 13px; color: var(--text); }
  .ctr-meta { font-size: 11px; color: var(--text-muted); display: flex; gap: 4px; flex-wrap: wrap; }
  .ctr-image { font-family: var(--font-mono, ui-monospace, monospace); }
  .ctr-compose { color: var(--text-faint); }
  .ctr-state { font-size: 10px; color: var(--text-faint); text-transform: capitalize; flex-shrink: 0; }
  .link-btn {
    border: 0; background: none; color: var(--accent); cursor: pointer;
    font: inherit; font-size: 12px; text-align: left; padding: 4px 0;
    min-height: 44px;
  }
  .disclosure {
    border: 0; background: none; color: var(--text-muted); cursor: pointer;
    font: inherit; font-size: 13px; text-align: left; padding: 4px 0;
    min-height: 44px;
  }
  .advanced-body, .customize-body { display: flex; flex-direction: column; gap: 12px; padding-left: 8px; }
  .resolved-id { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
  .backing-line { font-size: 11px; color: var(--text-muted); }
  .warning-box {
    border: 1px solid var(--warning, var(--border));
    border-radius: var(--radius-sm);
    padding: 12px;
    background: var(--warning-soft, var(--surface));
  }
  .warning-title { font-size: 13px; font-weight: 600; color: var(--warning, var(--accent)); margin-bottom: 4px; }
  .warning-body { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .risks-panel { display: flex; flex-direction: column; gap: 10px; }
  .risks-panel h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .risks-sub { font-size: 12px; color: var(--text-muted); line-height: 1.45; margin: 0; }
  .risk-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    background: var(--surface);
  }
  .risk-title { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .risk-body { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .provisioning { display: flex; flex-direction: column; gap: 8px; }
  .prov-subtitle { font-size: 14px; font-weight: 500; color: var(--text); }
  .prov-subline { font-size: 12px; color: var(--text-muted); }
  .phase-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .phase { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; }
  .phase-marker {
    width: 20px; height: 20px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600; flex-shrink: 0;
  }
  .phase.completed .phase-marker { background: var(--ok, var(--accent)); color: white; }
  .phase.active .phase-marker { background: var(--accent); color: white; }
  .phase.failed .phase-marker { background: var(--danger); color: white; }
  .phase.pending .phase-marker { background: var(--surface-sunken); color: var(--text-faint); }
  .phase-label { font-size: 13px; font-weight: 500; }
  .phase.completed .phase-label, .phase.active .phase-label { color: var(--text); }
  .phase.pending .phase-label { color: var(--text-muted); }
  .phase-detail { font-size: 11px; color: var(--text-muted); flex: 1; min-width: 0; }
  .tech-details-wrapper { margin-top: 6px; }
  .tech-details {
    font-size: 11px; color: var(--text-faint);
    background: var(--surface-sunken); padding: 8px; border-radius: var(--radius-xs);
    overflow-x: auto; white-space: pre-wrap; word-break: break-all;
    max-height: 150px; overflow-y: auto;
  }
  .readonly-field {
    padding: 9px 11px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--surface-sunken);
    font-size: 13px; color: var(--text-muted);
  }
  .docker-target-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .reconnect-notice {
    font-size: 12px; color: var(--accent);
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .pfoot {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 10px 20px calc(12px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .footer-right { font-size: 11px; color: var(--text-muted); text-align: right; }

  /* Discard confirmation overlay */
  .discard-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .discard-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 12px);
    padding: 20px;
    max-width: 360px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: var(--shadow-pop);
  }
  .discard-card h3 { margin: 0; font-size: 16px; font-weight: 600; }
  .discard-card p { margin: 0; font-size: 13px; color: var(--text-muted); line-height: 1.45; }
  .discard-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* Phone */
  @media (max-width: 859px) {
    .scrim { display: none; }
    .panel {
      z-index: 95; inset: 0; left: 0; bottom: 0;
      transform: none; width: 100dvw; height: 100dvh;
      max-height: none; border: 0; border-radius: 0; box-shadow: none; animation: none;
    }
    .phead {
      display: grid;
      grid-template-columns: minmax(72px, 1fr) auto minmax(72px, 1fr);
      min-height: calc(52px + env(safe-area-inset-top));
      box-sizing: border-box;
      padding: env(safe-area-inset-top) 8px 0;
    }
    .phead h2 { grid-column: 2; text-align: center; }
    .close-btn { grid-column: 3; justify-self: end; min-height: 44px; }
    .mobile-back {
      display: inline-flex; grid-column: 1; align-items: center;
      justify-self: start; min-width: 72px; min-height: 44px;
      padding: 0 8px 0 2px; border: 0; background: transparent;
      color: var(--accent); font: inherit; font-size: 14px; cursor: pointer;
    }
    .back-chevron { display: inline-flex; transform: rotate(180deg); }
    .body { padding: 0 16px calc(24px + env(safe-area-inset-bottom)); }
    .field input, .container-search, .port-input { min-height: 44px; }
    .container-row { min-height: 52px; }
    .pfoot { padding: 10px 16px calc(16px + env(safe-area-inset-bottom)); }
  }

  @keyframes rise {
    from { transform: translateX(-50%) translateY(16px); opacity: 0; }
  }
  @keyframes fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .scrim, .panel { animation: none; }
  }
</style>
