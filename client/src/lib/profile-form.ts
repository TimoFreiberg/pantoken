// Pure validation logic for the ComputerSetupSheet. Extracted so it can be
// unit-tested without a DOM, and shared between the setup component and tests.
//
// No Svelte, no DOM — pure functions.

import type {
  ExecutionTargetProfile,
  PolytokenPolicy,
  RemoteProfile,
} from "./hosts/types.js";
import type { ComputerSetupIntent } from "./profile-editor.svelte.js";

export interface ProfileFormDraft {
  label: string;
  sshDestination: string;
  port: string;
  remoteRootOverride: string;
  serverPath: string;
  executionTarget: ExecutionTargetProfile;
  dockerContainerName: string;
  dockerUser: string;
  dockerWorkdir: string;
  dockerPantokenRoot: string;
}

// ── ComputerSetupDraft: the single source of truth for form fields ─────────
//
// Captures every user-editable saved field in a plain object so it can be
// serialized (localStorage), compared (isDirty), and survive component
// remounts (lives in profileEditor, not the component's local $state).
//
// executionTarget uses the component-internal shorthand "host" | "docker"
// (matching ExecutionTargetKind). This is distinct from ExecutionTargetProfile,
// the discriminated union stored on RemoteProfile.

export interface ComputerSetupDraft {
  name: string;
  sshDestination: string;
  port: string;
  executionTarget: "host" | "docker";
  polytokenPolicy: PolytokenPolicy;
  serverPath: string;
  remoteRootOverride: string;
  containerName: string;
  containerUser: string;
  containerWorkdir: string;
  pantokenRoot: string;
}

/**
 * Project an unknown persisted value onto the supported draft contract.
 *
 * This intentionally does not spread the input object: older drafts may carry
 * removed `xdgMode`/`xdg_mode` keys, and rewriting a normalized draft must drop
 * them while preserving every supported field.
 */
export function normalizeComputerSetupDraft(value: unknown): ComputerSetupDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const stringFields = [
    "name",
    "sshDestination",
    "port",
    "serverPath",
    "remoteRootOverride",
    "containerName",
    "containerUser",
    "containerWorkdir",
    "pantokenRoot",
  ] as const;
  if (stringFields.some((field) => typeof input[field] !== "string")) return null;
  if (input.executionTarget !== "host" && input.executionTarget !== "docker") return null;
  if (input.polytokenPolicy !== "requireExisting" && input.polytokenPolicy !== "offerInstall") return null;
  return {
    name: input.name as string,
    sshDestination: input.sshDestination as string,
    port: input.port as string,
    executionTarget: input.executionTarget,
    polytokenPolicy: input.polytokenPolicy,
    serverPath: input.serverPath as string,
    remoteRootOverride: input.remoteRootOverride as string,
    containerName: input.containerName as string,
    containerUser: input.containerUser as string,
    containerWorkdir: input.containerWorkdir as string,
    pantokenRoot: input.pantokenRoot as string,
  };
}

/** Map the draft's shorthand executionTarget to the persisted union. */
export function draftToExecutionTargetProfile(
  draft: ComputerSetupDraft,
): ExecutionTargetProfile {
  if (draft.executionTarget === "host") return { kind: "host" };
  return {
    kind: "dockerContainer",
    containerName: draft.containerName,
    user: draft.containerUser,
    workdir: draft.containerWorkdir || undefined,
    pantokenRoot: draft.pantokenRoot,
  };
}

/** Map a RemoteProfile's executionTarget back to the draft shorthand. */
export function executionTargetProfileToDraft(
  profile: RemoteProfile,
): "host" | "docker" {
  return profile.executionTarget.kind === "dockerContainer" ? "docker" : "host";
}

/** Default draft for a new profile (host or docker). */
export function defaultDraft(intent: ComputerSetupIntent): ComputerSetupDraft {
  const isDocker =
    intent.kind === "edit"
      ? intent.profile.executionTarget.kind === "dockerContainer"
      : intent.initialTarget === "dockerContainer";
  return {
    name: "",
    sshDestination: "",
    port: "22",
    executionTarget: isDocker ? "docker" : "host",
    polytokenPolicy: "requireExisting",
    serverPath: "",
    remoteRootOverride: "",
    containerName: "",
    containerUser: "",
    containerWorkdir: "",
    pantokenRoot: "",
  };
}

/** Create a draft from a loaded RemoteProfile (for edit baseline). */
export function draftFromProfile(profile: RemoteProfile): ComputerSetupDraft {
  const target = profile.executionTarget;
  if (target.kind === "dockerContainer") {
    return {
      name: profile.label,
      sshDestination: profile.sshDestination,
      port: String(profile.port ?? 22),
      executionTarget: "docker",
      polytokenPolicy: profile.polytokenPolicy,
      serverPath: profile.serverPath ?? "",
      remoteRootOverride: profile.remoteRootOverride ?? "",
      containerName: target.containerName,
      containerUser: target.user,
      containerWorkdir: target.workdir ?? "",
      pantokenRoot: target.pantokenRoot,
    };
  }
  return {
    name: profile.label,
    sshDestination: profile.sshDestination,
    port: String(profile.port ?? 22),
    executionTarget: "host",
    polytokenPolicy: profile.polytokenPolicy,
    serverPath: profile.serverPath ?? "",
    remoteRootOverride: profile.remoteRootOverride ?? "",
    containerName: "",
    containerUser: "",
    containerWorkdir: "",
    pantokenRoot: "",
  };
}

/** Adapter: map the draft to the validation input shape. */
export function toValidationDraft(
  draft: ComputerSetupDraft,
): ProfileFormDraft {
  return {
    label: draft.name,
    sshDestination: draft.sshDestination,
    port: draft.port,
    remoteRootOverride: draft.remoteRootOverride,
    serverPath: draft.serverPath,
    executionTarget: draftToExecutionTargetProfile(draft),
    dockerContainerName: draft.containerName,
    dockerUser: draft.containerUser,
    dockerWorkdir: draft.containerWorkdir,
    dockerPantokenRoot: draft.pantokenRoot,
  };
}

/**
 * Deep-compare every saved field. Returns true if the draft differs from the
 * baseline. Replaces the old "any field non-empty" check which missed port,
 * executionTarget and serverPath changes.
 */
export function isDirty(
  baseline: ComputerSetupDraft | null,
  current: ComputerSetupDraft | null,
): boolean {
  if (!baseline || !current) return false;
  return (
    baseline.name !== current.name ||
    baseline.sshDestination !== current.sshDestination ||
    baseline.port !== current.port ||
    baseline.executionTarget !== current.executionTarget ||
    baseline.polytokenPolicy !== current.polytokenPolicy ||
    baseline.serverPath !== current.serverPath ||
    baseline.remoteRootOverride !== current.remoteRootOverride ||
    baseline.containerName !== current.containerName ||
    baseline.containerUser !== current.containerUser ||
    baseline.containerWorkdir !== current.containerWorkdir ||
    baseline.pantokenRoot !== current.pantokenRoot
  );
}

// ── SetupError: normalized error for structured UI ──────────────────────────

export interface SetupError {
  summary: string;
  detail?: string;
  operation: string;
  retryable: boolean;
}

/**
 * Normalize an unknown rejection into a structured SetupError. Never assumes
 * .message exists. Handles Error instances, strings, plain objects, and
 * null/undefined.
 */
export function normalizeError(err: unknown, operation: string): SetupError {
  if (err instanceof Error) {
    const detail = err.cause
      ? String(err.cause)
      : err.stack ?? err.toString();
    return {
      summary: err.message,
      detail: detail !== err.message ? detail : undefined,
      operation,
      retryable: true,
    };
  }
  if (typeof err === "string") {
    return {
      summary: err,
      operation,
      retryable: true,
    };
  }
  if (err && typeof err === "object") {
    const msg =
      (err as { message?: unknown }).message ??
      (err as { error?: unknown }).error ??
      JSON.stringify(err, null, 2);
    return {
      summary: typeof msg === "string" ? msg : String(msg),
      detail: JSON.stringify(err, null, 2),
      operation,
      retryable: true,
    };
  }
  return {
    summary: err == null ? "Unknown error" : String(err),
    operation,
    retryable: true,
  };
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/");
}

/** Validate a profile form draft. Returns an error message, or null if valid. */
export function validateProfileDraft(draft: ProfileFormDraft): string | null {
  if (!draft.label.trim()) return "Name is required";
  if (!draft.sshDestination.trim()) return "SSH destination is required";
  const port = draft.port.trim();
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return "Port must be an integer between 1 and 65535";
    }
  }
  const rootOverride = draft.remoteRootOverride.trim();
  if (rootOverride && !isAbsolutePath(rootOverride)) {
    return "Remote-root override must be an absolute path (starting with /)";
  }
  const serverPath = draft.serverPath.trim();
  if (serverPath && !isAbsolutePath(serverPath)) {
    return "Server path must be an absolute path (starting with /)";
  }
  if (draft.executionTarget.kind === "dockerContainer") {
    if (!draft.dockerContainerName.trim()) return "Container name is required for Docker targets";
    if (!draft.dockerUser.trim()) return "User is required for Docker targets";
    if (!draft.dockerPantokenRoot.trim()) return "Pantoken root is required for Docker targets";
    const root = draft.dockerPantokenRoot.trim();
    if (!isAbsolutePath(root)) return "Pantoken root must be an absolute path (starting with /)";
    const workdir = draft.dockerWorkdir.trim();
    if (workdir && !isAbsolutePath(workdir)) return "Workdir must be an absolute path (starting with /)";
  }
  return null;
}
