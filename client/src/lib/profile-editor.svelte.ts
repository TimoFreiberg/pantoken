import type { RemoteProfile } from "./hosts/types.js";

// Shared profile editor state. Manages the open/close state of the
// RemoteProfileForm sheet and the profile being edited (or null for "add new").
// Same singleton pattern as image-viewer.svelte.ts.
//
// The `containerWizard` flag selects between the simple form
// (RemoteProfileForm) and the interactive Docker setup flow
// (ContainerSetupSheet). Both watch `profileEditor.open`, but only one
// renders at a time based on this flag.

class ProfileEditorState {
  open = $state(false);
  editing = $state<RemoteProfile | null>(null);
  containerWizard = $state(false);

  openNew(): void {
    this.editing = null;
    this.containerWizard = false;
    this.open = true;
  }

  openNewContainer(): void {
    this.editing = null;
    this.containerWizard = true;
    this.open = true;
  }

  openEdit(profile: RemoteProfile): void {
    this.editing = profile;
    this.containerWizard = false;
    this.open = true;
  }

  openEditContainer(profile: RemoteProfile): void {
    this.editing = profile;
    this.containerWizard = true;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.editing = null;
    this.containerWizard = false;
  }
}

export const profileEditor = new ProfileEditorState();
