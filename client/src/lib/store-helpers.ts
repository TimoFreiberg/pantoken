import type { ModelDefaults, PermissionMonitorMode } from "@pantoken/protocol";

/** The new-session draft's configurable fields. Mirrors the inline `$state`
 *  type in `store.svelte.ts` (cwd + worktree + the model/thinking/facet/
 *  permissionMonitor overrides). Extracted here so pure helpers operating on
 *  a draft can be unit-tested without instantiating the Svelte 5 rune-based
 *  store singleton. */
export interface DraftConfig {
  cwd: string;
  worktree: boolean;
  model?: { provider: string; modelId: string };
  thinking?: string;
  /** Facet to start the session in (undefined = the daemon's default, execute). */
  facet?: string;
  permissionMonitor?: PermissionMonitorMode; // undefined/"standard" = default
}

/** Re-seed a draft's unset model/thinking from `modelDefaults`.
 *
 *  Covers the boot-path timing gap: `startDraft` fires on `sessionList` arrival,
 *  which can precede `modelDefaults` (the last message in the connect queue).
 *  The draft is then seeded from the initial empty `modelDefaults`, and when
 *  the real defaults arrive later this re-seeds the still-unset fields.
 *
 *  Only fills in fields that are `undefined` — a draft where the user (or a
 *  restored `draftConfigMap` override) already set a model/thinking/permission
 *  monitor is left untouched. Returns the same object reference when nothing
 *  changed (so Svelte doesn't trigger a spurious re-render), or a new spread
 *  when it did. */
export function reseedDraftFromDefaults(
  draft: DraftConfig,
  defaults: ModelDefaults,
): DraftConfig {
  let next = draft;
  if (!draft.model && defaults.provider && defaults.modelId) {
    next = { ...next, model: { provider: defaults.provider, modelId: defaults.modelId } };
  }
  if (!draft.thinking && defaults.thinkingLevel) {
    next = { ...next, thinking: defaults.thinkingLevel };
  }
  if (!draft.permissionMonitor && defaults.defaultPermissionMonitor) {
    next = { ...next, permissionMonitor: defaults.defaultPermissionMonitor };
  }
  return next;
}
