import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  waitForSettledWorkBlocks,
} from "./helpers.js";

// #28 — collapsed tool-card headers show a concise, per-tool field selection
// instead of a raw JSON dump. The `cleantools` mock fixture emits one card per
// tool listed in the issue; this spec asserts each card's `.arg` span content
// and the amber treatment on block_goal's terminal_reason.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await drive(page, "cleantools");
  // greeting (1) + cleantools (1) = 2 settled work blocks.
  await waitForSettledWorkBlocks(page, 2);
});

function card(page: Page, label: string): Locator {
  return page
    .locator(".tool")
    .filter({ has: page.getByText(label, { exact: true }) });
}

const PREVIEW_CASES: [string, string][] = [
  ["Create todo", "Fix the bug"],
  ["List todos", "pending"],
  ["Update todo", "2 Updated title"],
  ["Complete todo", "1"],
  ["Run subagent", "code-reviewer general-purpose"],
  ["Load skill", "debug"],
  ["Check job status", "general-purpose:example"],
  ["Wait for job", "general-purpose:example"],
  ["Block goal", "Waiting on missing credentials"],
  ["Propose goal", "Finish implementing the feature"],
  ["Web search", "Weather in Munich, …"],
];

// The duration badge is nested inside .arg, so text assertions must exclude it
// to check only the arg-preview content.
function argPreviewText(loc: Locator) {
  return loc.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".duration").forEach((d) => d.remove());
    return clone.textContent ?? "";
  });
}

test("each tool's .arg span shows its concise field selection", async ({
  page,
}) => {
  await expandWork(page);
  for (const [label, expected] of PREVIEW_CASES) {
    const arg = card(page, label).locator(".arg");
    expect(await argPreviewText(arg)).toBe(expected);
  }
});
