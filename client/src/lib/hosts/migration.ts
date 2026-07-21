// Legacy migration helper: copy unnamespaced localStorage data to a namespaced
// key for the initial local server id. Loss-averse: never deletes old keys.
//
// Once the initial local server id is known (from the first `hello`), treat
// old unnamespaced entries as belonging to that server. This is a one-time
// migration — idempotent (a second call is a no-op).

import { LEGACY_BASE_KEYS, LEGACY_KEYS, namespacedKey } from "./persistence.js";

/** Migrate legacy unnamespaced data to the initial local server id.
 *
 *  - Reads old global keys (pantoken.composerDrafts, pantoken.draftConfig, etc.).
 *  - If namespaced keys for `serverId` already exist, does nothing (already migrated).
 *  - If old global keys exist and namespaced keys don't, copies them over.
 *  - Never deletes the old keys (loss-averse; they're just ignored going forward).
 *
 *  @param serverId - The server id to migrate legacy data to.
 *  @returns `true` if migration occurred (any keys were copied). */
export function migrateLegacyPersistence(serverId: string): boolean {
  if (typeof localStorage === "undefined") return false;

  let migrated = false;

  for (const baseKey of LEGACY_BASE_KEYS) {
    const legacyKey = LEGACY_KEYS[baseKey];
    const namespaced = namespacedKey(baseKey, serverId);

    // If namespaced key already exists, this key was already migrated — skip.
    if (localStorage.getItem(namespaced) !== null) continue;

    // Read the legacy value.
    let raw: string | null;
    try {
      raw = localStorage.getItem(legacyKey);
    } catch {
      continue;
    }
    if (raw === null) continue;

    // Copy to the namespaced key.
    try {
      localStorage.setItem(namespaced, raw);
      migrated = true;
    } catch {
      // Storage full / unavailable — skip this key.
    }
  }

  return migrated;
}
