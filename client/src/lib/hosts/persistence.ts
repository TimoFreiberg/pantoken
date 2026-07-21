// Pure localStorage namespacing helpers for multi-host persistence.
//
// The current client uses unnamespaced localStorage keys (e.g.
// `pantoken.composerDrafts`). In multi-host mode, these must be namespaced
// by serverId so identical session ids/cwds on two servers don't collide.
//
// Naming convention: `pantoken.<serverId>.<baseKey>`
//
// No Svelte, no DOM-side-effects beyond localStorage (which is universally
// available in browser + test environments). The functions are pure in the
// sense that they read/write localStorage with deterministic key derivation.

/** The legacy (unnamespaced) localStorage keys that are being migrated.
 *  Each entry maps a base suffix to its full legacy key. */
export const LEGACY_KEYS = {
  composerDrafts: "pantoken.composerDrafts",
  draftConfig: "pantoken.draftConfig",
  promptHistory: "pantoken.promptHistory",
  lastProjectCwd: "pantoken.lastProjectCwd",
  scrollPositions: "pantoken.scrollPositions",
} as const;

/** The base key suffixes (without the `pantoken.` prefix) used for namespacing. */
export const LEGACY_BASE_KEYS = [
  "composerDrafts",
  "draftConfig",
  "promptHistory",
  "lastProjectCwd",
  "scrollPositions",
] as const;

/** Derive a namespaced localStorage key for a serverId.
 *
 *  Format: `pantoken.<serverId>.<baseKey>`
 *  Example: `pantoken.abc-123.composerDrafts` */
export function namespacedKey(baseKey: string, serverId: string): string {
  return `pantoken.${serverId}.${baseKey}`;
}

/** Load a namespaced map from localStorage.
 *
 *  @param baseKey - The legacy key suffix (e.g. "composerDrafts").
 *  @param serverId - The server to scope the key to.
 *  @returns The parsed map, or an empty object if missing/corrupt. */
export function loadNamespacedMap<T>(
  baseKey: string,
  serverId: string,
): Record<string, T> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(namespacedKey(baseKey, serverId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, T>;
  } catch {
    return {};
  }
}

/** Persist a namespaced map to localStorage.
 *
 *  @param baseKey - The legacy key suffix (e.g. "composerDrafts").
 *  @param serverId - The server to scope the key to.
 *  @param map - The map to persist. */
export function persistNamespacedMap<T>(
  baseKey: string,
  serverId: string,
  map: Record<string, T>,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      namespacedKey(baseKey, serverId),
      JSON.stringify(map),
    );
  } catch {
    // Storage full / unavailable (private mode) — data stays in-memory this session.
  }
}

/** Persist a namespaced scalar (string) to localStorage.
 *
 *  @param baseKey - The legacy key suffix (e.g. "lastProjectCwd").
 *  @param serverId - The server to scope the key to.
 *  @param value - The scalar value to persist. */
export function persistNamespacedScalar(
  baseKey: string,
  serverId: string,
  value: string,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(namespacedKey(baseKey, serverId), value);
  } catch {
    // Storage full / unavailable (private mode).
  }
}

/** Load a namespaced scalar (string) from localStorage.
 *
 *  @param baseKey - The legacy key suffix (e.g. "lastProjectCwd").
 *  @param serverId - The server to scope the key to.
 *  @returns The stored string, or null if missing. */
export function loadNamespacedScalar(
  baseKey: string,
  serverId: string,
): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(namespacedKey(baseKey, serverId));
  } catch {
    return null;
  }
}
