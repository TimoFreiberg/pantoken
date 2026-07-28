import type { RemoteProfile } from "./hosts/types.js";
import {
  type ComputerSetupDraft,
  defaultDraft,
  draftFromProfile,
} from "./profile-form.js";

/**
 * Execution environment selected at profile-creation time. Immutable once a
 * profile is saved — editing a profile always derives its environment from
 * the persisted `RemoteProfile.executionTarget`.
 */
export type ExecutionEnvironment = "host" | "dockerContainer";

/**
 * Explicit launch intent for the computer-setup sheet. Makes invalid
 * combinations impossible: "new" carries the initial environment, "edit"
 * carries the profile (whose executionTarget determines the environment).
 */
export type ComputerSetupIntent =
  | { kind: "new"; initialTarget: ExecutionEnvironment }
  | { kind: "edit"; profile: RemoteProfile };

/** Where the setup sheet was opened from, for focus restoration. */
export type LaunchOrigin = "hostSwitcher" | "settings" | null;

/** localStorage key for persisting the draft (best-effort, no secrets). */
const DRAFT_STORAGE_KEY = "pantoken.computerSetupDraft";

/** Deep-clone a draft. structuredClone fails on Svelte $state proxies, but the
 *  draft is a plain object with only string fields, so JSON round-trip is safe
 *  and avoids the proxy-cloning error. */
function cloneDraft(draft: ComputerSetupDraft): ComputerSetupDraft {
  return JSON.parse(JSON.stringify(draft)) as ComputerSetupDraft;
}

// Shared profile editor state. Manages the open/close state of the
// ComputerSetupSheet and the launch intent (new host / new docker / edit).
// Same singleton pattern as image-viewer.svelte.ts.
//
// The draft and baseline live here (not in the component's local $state) so
// they survive component remounts. localStorage persistence is best-effort:
// a storage failure must never prevent in-memory editing.

class ProfileEditorState {
  open = $state(false);
  editing = $state<RemoteProfile | null>(null);
  intent = $state<ComputerSetupIntent | null>(null);

  // ── Draft state (survives component remounts) ────────────────────────────
  /** The live draft, or null when no form is active. */
  draft = $state<ComputerSetupDraft | null>(null);
  /** The comparison baseline (snapshot at open time). */
  baseline = $state<ComputerSetupDraft | null>(null);
  /** True while an edit profile is being fetched. */
  loadingProfile = $state(false);
  /** Where the setup sheet was launched from, for focus restoration. */
  launchOrigin: LaunchOrigin = null;

  /** The recorded launching control (not reactive; set on open, cleared on close). */
  launcher: HTMLElement | null = null;

  openNew(): void {
    this.launcher = document.activeElement as HTMLElement | null;
    this.editing = null;
    this.intent = { kind: "new", initialTarget: "host" };
    // Try restoring from localStorage first.
    this.draft = this.loadDraftFromStorage() ?? defaultDraft(this.intent);
    this.baseline = cloneDraft(this.draft);
    this.loadingProfile = false;
    this.open = true;
  }

  openNewDocker(): void {
    this.launcher = document.activeElement as HTMLElement | null;
    this.editing = null;
    this.intent = { kind: "new", initialTarget: "dockerContainer" };
    // Try restoring from localStorage first.
    this.draft = this.loadDraftFromStorage() ?? defaultDraft(this.intent);
    this.baseline = cloneDraft(this.draft);
    this.loadingProfile = false;
    this.open = true;
  }

  openEdit(profile: RemoteProfile): void {
    this.launcher = document.activeElement as HTMLElement | null;
    this.editing = profile;
    this.intent = { kind: "edit", profile };
    // Edit mode: draft is populated after loading the full profile.
    this.draft = null;
    this.baseline = null;
    this.loadingProfile = true;
    this.open = true;
  }

  /** Called by the component after fetching the full edit profile. */
  setEditDraft(loaded: RemoteProfile): void {
    this.draft = draftFromProfile(loaded);
    this.baseline = cloneDraft(this.draft);
    this.loadingProfile = false;
  }

  /** Clear the draft and baseline (after confirmed save or explicit discard). */
  clearDraft(): void {
    this.draft = null;
    this.baseline = null;
    this.clearDraftFromStorage();
  }

  /** Set the launch origin (called by HostSwitcher / Settings before opening). */
  setLaunchOrigin(origin: LaunchOrigin): void {
    this.launchOrigin = origin;
  }

  close(): void {
    // Do NOT clear the draft — it survives remounts. Only clearDraft() clears it.
    this.open = false;
    this.editing = null;
    this.intent = null;
    this.loadingProfile = false;
  }

  // ── localStorage persistence (best-effort) ────────────────────────────────
  // The ComputerSetupDraft includes sshDestination (user@host). This is safe to
  // persist: RemoteProfile explicitly carries no secrets (no passwords, keys,
  // tokens, or passphrases by design — types.ts:219-221). The issue's
  // restriction does not list SSH destinations.

  /** Persist the current draft to localStorage. Called via $effect on draft change. */
  persistDraft(): void {
    if (!this.draft) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(this.draft));
    } catch {
      // Storage failure must not prevent in-memory editing.
    }
  }

  /** Load a draft from localStorage, or null if absent/invalid. */
  loadDraftFromStorage(): ComputerSetupDraft | null {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as ComputerSetupDraft;
    } catch {
      return null;
    }
  }

  /** Remove the persisted draft from localStorage. */
  clearDraftFromStorage(): void {
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // Storage failure is non-fatal.
    }
  }
}

export const profileEditor = new ProfileEditorState();
