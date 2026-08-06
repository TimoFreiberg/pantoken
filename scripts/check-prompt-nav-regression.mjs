// Canonical repository-wide prompt-nav no-arrow guard (issue #166).
//
// The floating previous/next prompt-nav arrows are gone: the prompt map owns
// navigation for multi-prompt transcripts, and zero or one prompt has nothing to
// navigate to. This script scans every tracked UTF-8/text file and rejects every
// `prompt-nav` / `prompt-nav-up` / `prompt-nav-down` occurrence EXCEPT the four
// filename-specific whole-line absence assertions in the two prompt-map E2E specs
// (which must keep proving the arrows are never mounted).
//
// It also self-checks its own matcher (a positive visibility/title/click/press
// occurrence must be rejected) and enforces the PromptMap.svelte source shape:
// the component must pair indices with projected positions via `pairPromptTicks`
// and must not render the dense `entries.slice(windowStart, windowEnd + 1)` list.

import fs from "node:fs";
import { execSync } from "node:child_process";

const FORBIDDEN = ["prompt-nav", "prompt-nav-up", "prompt-nav-down"];

// The only permitted matches: exact whole-line absence assertions, one per arrow
// test id, in exactly these two files.
const ALLOWED_ASSERTIONS = new Set([
  'await expect(page.getByTestId("prompt-nav-up")).toHaveCount(0)',
  'await expect(page.getByTestId("prompt-nav-down")).toHaveCount(0)',
]);
const ALLOWED_FILES = new Set(["e2e/prompt-map.e2e.ts", "e2e/prompt-map.mobile.e2e.ts"]);

const GUARD_SCRIPT = "scripts/check-prompt-nav-regression.mjs";

/** Normalize a source line for the whole-line allowlist (trim, drop trailing ;). */
function normalizeLine(line) {
  return line.trim().replace(/;$/, "");
}

/** Scan one file's text for forbidden prompt-nav tokens. Returns hit strings. */
export function scanText(text, filename) {
  const hits = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (!FORBIDDEN.some((token) => line.includes(token))) return;
    const normalized = normalizeLine(line);
    const allowed =
      ALLOWED_FILES.has(filename) && ALLOWED_ASSERTIONS.has(normalized);
    if (!allowed) hits.push(`${filename}:${index + 1}: ${line.trim()}`);
  });
  return hits;
}

/** Prove the matcher rejects positive (visibility/title/click/press) occurrences. */
function selfCheck() {
  const positive = [
    'await expect(page.getByTestId("prompt-nav-up")).toBeVisible();',
    'await expect(page.getByTestId("prompt-nav-down")).toHaveAttribute("title", "Next prompt");',
    'await page.getByTestId("prompt-nav-up").click();',
    'await page.getByTestId("prompt-nav-down").press("Enter");',
    'test("prev/next prompt-nav buttons are visible on hover and step through prompts", async ({',
  ];
  for (const line of positive) {
    const hits = scanText(`${line}\n`, "e2e/polish.e2e.ts");
    if (hits.length === 0) {
      throw new Error(`self-check failed: positive prompt-nav occurrence was allowed: ${line}`);
    }
  }
}

/** Enforce the PromptMap.svelte source shape (paired, not dense, rendering). */
function sourceShapeChecks() {
  const promptMap = fs.readFileSync("client/src/components/PromptMap.svelte", "utf8");
  if (!/\bpairPromptTicks\b/.test(promptMap)) {
    throw new Error(
      "PromptMap.svelte must import/call pairPromptTicks (paired index/position projection)",
    );
  }
  if (/entries\.slice\(\s*windowStart\s*,\s*windowEnd\s*\+\s*1\s*\)/.test(promptMap)) {
    throw new Error(
      "PromptMap.svelte must not render the dense entries.slice(windowStart, windowEnd + 1) list",
    );
  }
}

function main() {
  selfCheck();
  sourceShapeChecks();

  const tracked = execSync("git ls-files", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .trim()
    .split("\n")
    .filter(Boolean);

  const failures = [];
  for (const file of tracked) {
    if (file === GUARD_SCRIPT) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // unreadable / not a regular file
    }
    if (text.includes("\u0000")) continue; // binary
    failures.push(...scanText(text, file));
  }

  if (failures.length > 0) {
    console.error("prompt-nav regression: forbidden references found:");
    for (const hit of failures) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log("prompt-nav regression checks passed: no arrow references anywhere");
}

main();
