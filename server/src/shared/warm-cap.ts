// LRU eviction policy for a driver's kept-warm session set. Pure + generic so the
// policy is unit-tested without touching real sessions.

/** Pick the least-recently-focused ids to evict so the set fits `cap`. `order` is
 *  oldest→newest by focus recency; `protectedId` is never evicted (the session about to
 *  be focused); `evictable` filters out sessions that must not be evicted right now
 *  (e.g. a mid-turn background session — evicting it kills the running turn and makes
 *  it look finished via the synthetic `sessionClosed`); `cap` ≤ 0 means unbounded
 *  (evict nothing).
 *
 *  When not enough sessions are evictable to reach the cap, the returned list is
 *  shorter than `need` — the caller stays temporarily over-cap until a turn finishes
 *  or another session is focused. The caller should log loudly in that case. */
export function evictionPlan<T>(
  order: readonly T[],
  protectedId: T | null,
  cap: number,
  evictable: (id: T) => boolean = () => true,
): T[] {
  if (cap <= 0 || order.length <= cap) return [];
  const need = order.length - cap;
  const evict: T[] = [];
  for (const id of order) {
    if (evict.length >= need) break;
    if (id === protectedId) continue;
    if (!evictable(id)) continue;
    evict.push(id);
  }
  return evict;
}
