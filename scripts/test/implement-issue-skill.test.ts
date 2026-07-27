import { expect, test } from "vitest";
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
  ordered(skill, ["just create-workspace", "pushd", "pnpm install", "gh-issue-fetch.sh"]);
  expect(skill).toContain("quality-review");
  expect(skill).toContain("integrate-into-main");
});

test("skill step 0 has plan-mode authorization note", () => {
  // AC.1: note appears between Step 0 heading and the bash block
  ordered(skill, ["## Step 0", "also in the plan facet", "just create-workspace"]);
  // AC.2: note explains why read-only substitutes are insufficient
  expect(skill).toContain("implement-issue-number");
  // AC.3: note frames authorization as operator-invoked, not blanket override
  expect(skill).toContain("operator's explicit request");
});

test("seed prompt mirrors lifecycle and explicit CLI handoff", () => {
  ordered(seed, ["just create-workspace", "pushd", "pnpm install", "gh-issue-fetch.sh"]);
  expect(seed).toContain("quality-review");
  expect(seed).toContain("integrate-into-main");
});
