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
  ordered(skill, ["just create-workspace", "pushd", "bun install", "gh-issue-fetch.sh", ".implement-issue-session-id"]);
  expect(skill).toContain("POLYTOKEN_SESSION_ID");
  expect(skill).toContain("execute-implementation-plan");
});

test("seed prompt mirrors lifecycle and explicit CLI handoff", () => {
  ordered(seed, ["just create-workspace", "pushd", "bun install", "gh-issue-fetch.sh", "{{ISSUE_CONTEXT_DIR}}/session-id", ".implement-issue-session-id"]);
  expect(seed).toContain("{{ISSUE_CONTEXT_DIR}}");
  expect(seed).toContain("execute-implementation-plan");
});
