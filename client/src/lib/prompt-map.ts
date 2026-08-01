export type PromptResponseState = "final" | "in-progress" | "none";

export interface PromptMapEntry {
  id: string;
  prompt: string;
  response: string;
  responseState: PromptResponseState;
}

export interface PromptInterval {
  index: number;
  id?: string;
  start: number;
  end: number;
  active: boolean;
}

export interface PromptWindow {
  start: number;
  end: number;
  indices: number[];
  capacity: number;
  activeIndices: number[];
  overCapacity: boolean;
  omittedBefore: boolean;
  omittedAfter: boolean;
  primaryIndex: number | null;
}

/** Collapse transcript whitespace and keep the first few words for rail chrome. */
export function truncatePromptPreview(text: string, maxWords = 8): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || maxWords <= 0) return "";
  const words = normalized.split(" ");
  if (words.length <= maxWords) return normalized;
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * Prepare assistant text for a compact preview. The caller is responsible for supplying
 * only text-bearing response items, which keeps thinking/tool output out of this helper.
 */
export function responsePreview(text: string, maxLines = 3): string[] {
  if (maxLines <= 0) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

export function responseFallback(state: PromptResponseState): string {
  return state === "in-progress" ? "Response in progress…" : "No final response";
}

/** Build prompt intervals in transcript document coordinates. */
export function calculatePromptIntervals(
  offsets: readonly number[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  ids?: readonly string[],
): PromptInterval[] {
  const viewportStart = Math.max(0, scrollTop);
  const viewportEnd = viewportStart + Math.max(0, clientHeight);
  const contentEnd = Math.max(viewportEnd, scrollHeight, 0);
  return offsets.map((rawStart, index) => {
    const start = Math.max(0, Number.isFinite(rawStart) ? rawStart : 0);
    const next = offsets[index + 1];
    const end = Math.max(
      start,
      next !== undefined && Number.isFinite(next) ? next : contentEnd,
    );
    return {
      index,
      id: ids?.[index],
      start,
      end,
      active: start <= viewportEnd && end >= viewportStart,
    };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Select a contiguous rail slice. Active intervals are never dropped. When the active
 * set is empty, the nearest measured prompt (or stable primary) keeps the window steady.
 */
export function selectPromptWindow(options: {
  total: number;
  activeIndices?: readonly number[];
  availableHeight: number;
  tickPitch: number;
  contextPadding?: number;
  nearestIndex?: number | null;
  stablePrimaryIndex?: number | null;
}): PromptWindow {
  const total = Math.max(0, Math.floor(options.total));
  if (total === 0) {
    return {
      start: 0,
      end: -1,
      indices: [],
      capacity: 0,
      activeIndices: [],
      overCapacity: false,
      omittedBefore: false,
      omittedAfter: false,
      primaryIndex: null,
    };
  }

  const capacity = Math.max(
    1,
    Math.floor(Math.max(0, options.availableHeight) / Math.max(1, options.tickPitch)),
  );
  const active = [...new Set(options.activeIndices ?? [])]
    .filter((index) => index >= 0 && index < total)
    .sort((a, b) => a - b);
  const primaryIndex = active[0] ??
    (options.nearestIndex != null
      ? clamp(Math.floor(options.nearestIndex), 0, total - 1)
      : options.stablePrimaryIndex != null
        ? clamp(Math.floor(options.stablePrimaryIndex), 0, total - 1)
        : total - 1);

  const activeSpan = active.length > 0 ? active[active.length - 1]! - active[0]! + 1 : 0;
  if (active.length > capacity || activeSpan > capacity) {
    const start = active[0]!;
    const end = active[active.length - 1]!;
    return {
      start,
      end,
      indices: active,
      capacity,
      activeIndices: active,
      overCapacity: true,
      omittedBefore: start > 0,
      omittedAfter: end < total - 1,
      primaryIndex,
    };
  }

  const anchorStart = active.length > 0 ? active[0]! : primaryIndex;
  const anchorEnd = active.length > 0 ? active[active.length - 1]! : primaryIndex;
  let start = anchorStart;
  let end = anchorEnd;
  const context = Math.max(0, Math.floor(options.contextPadding ?? 1));
  const desiredStart = Math.max(0, anchorStart - context);
  const desiredEnd = Math.min(total - 1, anchorEnd + context);
  start = desiredStart;
  end = desiredEnd;

  while (end - start + 1 < capacity && (start > 0 || end < total - 1)) {
    if (start > 0) start--;
    if (end - start + 1 >= capacity) break;
    if (end < total - 1) end++;
  }
  if (end - start + 1 > capacity) end = start + capacity - 1;
  if (end > total - 1) {
    end = total - 1;
    start = Math.max(0, end - capacity + 1);
  }
  if (start > anchorStart) start = anchorStart;
  if (end < anchorEnd) {
    end = anchorEnd;
    start = Math.max(0, end - capacity + 1);
  }

  const indices = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  return {
    start,
    end,
    indices,
    capacity,
    activeIndices: active,
    overCapacity: false,
    omittedBefore: start > 0,
    omittedAfter: end < total - 1,
    primaryIndex,
  };
}

/** Project document offsets into a monotonic rail coordinate system. */
export function projectPromptTicks(
  offsets: readonly number[],
  usableHeight: number,
  minTickPitch: number,
): number[] {
  if (offsets.length === 0) return [];
  if (offsets.length === 1) return [Math.max(0, usableHeight / 2)];
  const height = Math.max(0, usableHeight);
  const minimum = Math.max(0, minTickPitch);
  const span = Math.max(0, offsets[offsets.length - 1]! - offsets[0]!);
  const required = minimum * (offsets.length - 1);
  const scale = span > 0 ? Math.max(0, Math.min(1, height / span)) : 0;
  const raw = offsets.map((offset) =>
    span === 0 ? 0 : (offset - offsets[0]!) * scale,
  );
  if (required <= height && raw.every((value, i) => i === 0 || value - raw[i - 1]! >= minimum)) {
    return raw;
  }
  return offsets.map((_, index) =>
    required === 0 ? 0 : (height * index) / (offsets.length - 1),
  );
}
