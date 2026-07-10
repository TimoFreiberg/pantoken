export const DEFAULT_SIDEBAR_WIDTH = 288;
export const DEFAULT_RIGHT_SIDEBAR_WIDTH = 280;
export const MIN_SIDEBAR_WIDTH = 200;
export const MIN_RIGHT_SIDEBAR_WIDTH = 200;
export const MAIN_MIN_WIDTH = 360;
export const MAX_STORED_SIDEBAR_WIDTH = 2000;

/** Widths are persisted in CSS pixels. Rendering clamps them against the current CSS viewport. */
export function sanitizeStoredWidth(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_STORED_SIDEBAR_WIDTH) return null;
  return n;
}

export function parseStoredWidth(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  return sanitizeStoredWidth(raw) ?? fallback;
}

export interface EffectiveWidths {
  left: number;
  right: number;
}

export function effectiveWidths(
  rawLeft: number,
  rawRight: number,
  viewportWidth: number,
  leftOpen: boolean,
  rightOpen: boolean,
): EffectiveWidths {
  const left = Math.max(MIN_SIDEBAR_WIDTH, rawLeft);
  const right = Math.max(MIN_RIGHT_SIDEBAR_WIDTH, rawRight);
  if (!leftOpen && !rightOpen) return { left, right };

  const budget = Math.max(0, viewportWidth - MAIN_MIN_WIDTH);
  if (leftOpen && !rightOpen)
    return { left: Math.max(MIN_SIDEBAR_WIDTH, Math.min(left, budget)), right };
  if (!leftOpen && rightOpen)
    return { left, right: Math.max(MIN_RIGHT_SIDEBAR_WIDTH, Math.min(right, budget)) };

  const minimumTotal = MIN_SIDEBAR_WIDTH + MIN_RIGHT_SIDEBAR_WIDTH;
  if (budget < minimumTotal) return { left: MIN_SIDEBAR_WIDTH, right: MIN_RIGHT_SIDEBAR_WIDTH };
  const total = left + right;
  if (total <= budget) return { left, right };

  const excess = total - budget;
  const leftReducible = left - MIN_SIDEBAR_WIDTH;
  const rightReducible = right - MIN_RIGHT_SIDEBAR_WIDTH;
  const reducible = leftReducible + rightReducible;
  if (reducible <= 0) return { left: MIN_SIDEBAR_WIDTH, right: MIN_RIGHT_SIDEBAR_WIDTH };
  const leftReduction = Math.min(leftReducible, excess * (leftReducible / reducible));
  const rightReduction = Math.min(rightReducible, excess - leftReduction);
  return { left: left - leftReduction, right: right - rightReduction };
}

export function maxWidthFor(
  side: "left" | "right",
  viewportWidth: number,
  otherOpen: boolean,
): number {
  const budget = Math.max(0, viewportWidth - MAIN_MIN_WIDTH);
  if (!otherOpen) return Math.max(side === "left" ? MIN_SIDEBAR_WIDTH : MIN_RIGHT_SIDEBAR_WIDTH, budget);
  return Math.max(side === "left" ? MIN_SIDEBAR_WIDTH : MIN_RIGHT_SIDEBAR_WIDTH, budget - (side === "left" ? MIN_RIGHT_SIDEBAR_WIDTH : MIN_SIDEBAR_WIDTH));
}
