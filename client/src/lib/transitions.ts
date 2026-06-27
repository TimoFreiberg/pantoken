import { slide } from "svelte/transition";
import type { SlideParams, TransitionConfig } from "svelte/transition";

// The one collapse/disclosure animation for the app: a height+opacity glide, matching the
// sidebar project groups (the reference). Wraps Svelte's `slide` so every collapsible
// section shares a single duration AND honours `prefers-reduced-motion` — reduced-motion
// users get an instant snap (duration 0) instead of the glide, the same courtesy the
// shared <Chevron> already extends to its rotation.
//
// Usage: `transition:reveal` (default 160ms) or `transition:reveal={{ duration, axis }}`.
export const REVEAL_MS = 160;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The pure core of {@link reveal}: the effective duration for a transition given the
 *  reduced-motion preference + caller params. Split out (mirroring theme.ts's
 *  resolveThemeMode / notify.ts's shouldNotify pattern) so the duration decision is
 *  unit-testable without a window/matchMedia dependency. Reduced motion forces 0
 *  (instant snap) regardless of the caller's requested duration; otherwise the caller's
 *  duration wins, falling back to REVEAL_MS. */
export function revealDuration(
  params: SlideParams,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return 0;
  return params.duration ?? REVEAL_MS;
}

export function reveal(
  node: Element,
  params: SlideParams = {},
): TransitionConfig {
  const duration = revealDuration(params, prefersReducedMotion());
  return slide(node, { ...params, duration });
}
