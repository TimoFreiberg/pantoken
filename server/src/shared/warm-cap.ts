// LRU eviction policy for a driver's kept-warm session set. Pure + generic so the
// policy is unit-tested without touching real sessions.

/** Pick the least-recently-focused ids to evict so the set fits `cap`. `order` is
 *  oldest→newest by focus recency; `protectedId` is never evicted (the session about to
 *  be focused); `cap` ≤ 0 means unbounded (evict nothing). */
export function evictionPlan<T>(
  order: readonly T[],
  protectedId: T | null,
  cap: number,
): T[] {
  if (cap <= 0 || order.length <= cap) return [];
  const need = order.length - cap;
  const evict: T[] = [];
  for (const id of order) {
    if (evict.length >= need) break;
    if (id === protectedId) continue;
    evict.push(id);
  }
  return evict;
}
