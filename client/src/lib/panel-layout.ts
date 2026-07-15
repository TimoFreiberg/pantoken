import {
  MAIN_MIN_WIDTH,
  MIN_RIGHT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "./sidebar-width.js";

export type RightSidebarPreference = "auto" | "closed";
export type MobileView = "transcript" | "sessions" | "context";

/** The reading-width budget shared by auto visibility and panel resizing. */
export const AUTO_RIGHT_MAIN_MIN_WIDTH = MAIN_MIN_WIDTH;

export function parseRightSidebarPreference(
  stored: string | null,
  legacyOpen: string | null,
): RightSidebarPreference {
  if (stored === "auto" || stored === "closed") return stored;
  return legacyOpen === "0" ? "closed" : "auto";
}

/** Whether auto mode has room for both chosen panel widths and a comfortable
 * transcript. Panel preferences are CSS pixels and already sanitized at load. */
export function canShowAutoRightSidebar(
  viewportWidth: number,
  leftOpen: boolean,
  leftWidth: number,
  rightWidth: number,
): boolean {
  const effectiveLeft = leftOpen ? Math.max(MIN_SIDEBAR_WIDTH, leftWidth) : 0;
  const effectiveRight = Math.max(MIN_RIGHT_SIDEBAR_WIDTH, rightWidth);
  return (
    viewportWidth >= effectiveLeft + effectiveRight + AUTO_RIGHT_MAIN_MIN_WIDTH
  );
}
