import type { RemoteProfile } from "./hosts/types.js";

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

// Shared profile editor state. Manages the open/close state of the
// ComputerSetupSheet and the launch intent (new host / new docker / edit).
// Same singleton pattern as image-viewer.svelte.ts.

class ProfileEditorState {
  open = $state(false);
  editing = $state<RemoteProfile | null>(null);
  intent = $state<ComputerSetupIntent | null>(null);

  openNew(): void {
    this.editing = null;
    this.intent = { kind: "new", initialTarget: "host" };
    this.open = true;
  }

  openNewDocker(): void {
    this.editing = null;
    this.intent = { kind: "new", initialTarget: "dockerContainer" };
    this.open = true;
  }

  openEdit(profile: RemoteProfile): void {
    this.editing = profile;
    this.intent = { kind: "edit", profile };
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.editing = null;
    this.intent = null;
  }
}

export const profileEditor = new ProfileEditorState();
