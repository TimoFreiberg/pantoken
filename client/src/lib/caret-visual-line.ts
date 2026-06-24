// Visual-line detection for the composer's history navigation. The logical-line helpers
// in prompt-history.ts only see manual newlines; these see where the textarea *renders*
// a line break (soft wrap). ArrowUp recalls history when the caret is on the first
// *visual* row, ArrowDown when it's on the last — so a long wrapped paragraph behaves
// like the multi-row block it looks like, not a single logical line.
//
// Technique: a hidden mirror <div> that reproduces the textarea's text layout (content
// width + font metrics + pre-wrap), with a marker span at the caret. The marker's
// offsetTop tells us which visual row the caret sits on. Compared against the marker at
// offset 0 (always the top row) and at value.length (always the bottom row). Adapted from
// component/textarea-caret-position, reduced to the vertical axis we care about.

import { caretOnFirstLine, caretOnLastLine } from "./prompt-history.js";

// Font/text properties that influence soft-wrap points and row height. Copied verbatim
// from the textarea's computed style so the mirror wraps identically.
const COPIED_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
] as const;

/** Vertical offset (px, rounded by the browser) of the caret at `index` within `ta`,
 *  measured via a throwaway mirror div. Throws if the DOM/layout is unavailable. */
function caretTop(ta: HTMLTextAreaElement, index: number): number {
  const cs = getComputedStyle(ta);
  const div = document.createElement("div");
  const s = div.style;
  s.position = "absolute";
  s.visibility = "hidden";
  s.top = "0";
  s.left = "-9999px";
  s.boxSizing = "content-box";
  s.whiteSpace = "pre-wrap";
  s.overflowWrap = cs.overflowWrap || "break-word";
  s.wordBreak = cs.wordBreak;
  // clientWidth excludes border + scrollbar; subtract padding to get the text content
  // width. Using this (rather than computed `width`) keeps wrapping correct even when the
  // textarea is scrolled and showing a vertical scrollbar.
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  s.width = `${ta.clientWidth - padL - padR}px`;
  for (const p of COPIED_PROPS) s[p] = cs[p];

  // Text up to the caret determines wrapping up to that point; the marker then sits on the
  // caret's visual row. A zero-width space gives the marker a layout box on a fresh row
  // when the preceding text ends in a newline.
  div.textContent = ta.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  div.appendChild(marker);

  document.body.appendChild(div);
  try {
    return marker.offsetTop;
  } finally {
    document.body.removeChild(div);
  }
}

/** True when the caret is on the first *visual* row (top of a soft-wrapped block) — the
 *  gate for ArrowUp to recall history. Falls back to the logical-line check if layout
 *  can't be measured. */
export function caretOnFirstVisualLine(ta: HTMLTextAreaElement): boolean {
  try {
    return caretTop(ta, ta.selectionStart) === caretTop(ta, 0);
  } catch {
    return caretOnFirstLine(ta.value, ta.selectionStart);
  }
}

/** True when the caret is on the last *visual* row (bottom of a soft-wrapped block) — the
 *  gate for ArrowDown to walk history forward. Falls back to the logical-line check if
 *  layout can't be measured. */
export function caretOnLastVisualLine(ta: HTMLTextAreaElement): boolean {
  try {
    return caretTop(ta, ta.selectionStart) === caretTop(ta, ta.value.length);
  } catch {
    return caretOnLastLine(ta.value, ta.selectionStart);
  }
}
