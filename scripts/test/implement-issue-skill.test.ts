import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../../.agents/skills/implement-issue/SKILL.md", import.meta.url), "utf8");
const seed = readFileSync(new URL("../seed-prompt.md", import.meta.url), "utf8");

function ordered(text: string, terms: string[]): void {
  let previous = -1;
  for (const term of terms) {
    const position = text.indexOf(term);
    expect(position, `missing: ${term}`).toBeGreaterThanOrEqual(0);
    expect(position, `out of order: ${term}`).toBeGreaterThan(previous);
    previous = position;
  }
}

test("skill lifecycle commands are ordered", () => {
  ordered(skill, ["scripts/create-workspace.sh", "pushd", "bun install", "cp scripts/polytoken-config/hooks.json", ".autopilot-session-id", "just integrate-into-main", "scripts/cleanup-current-workspace.sh", "popd"]);
  expect(skill).toContain("POLYTOKEN_SESSION_ID");
  expect(skill).toContain("POLYTOKEN_PROJECT_DIR");
});

test("seed prompt mirrors lifecycle and explicit CLI handoff", () => {
  ordered(seed, ["scripts/create-workspace.sh", "pushd", "bun install", "cp scripts/polytoken-config/hooks.json", "{{ISSUE_CONTEXT_DIR}}/session-id", ".autopilot-session-id", "just integrate-into-main", "scripts/cleanup-current-workspace.sh", "popd"]);
  expect(seed).toContain("{{ISSUE_CONTEXT_DIR}}");
  expect(seed).toContain(".autopilot-workspace-dir");
});
