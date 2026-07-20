import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, "..", "..", ".polytoken", "skills", "implement-issue", "SKILL.md");

describe("implement-issue skill body (AC.2)", () => {
  const body = readFileSync(SKILL_PATH, "utf-8");

  test("implement_issue_skill_contains_workflow: has two-phase contract", () => {
    expect(body).toContain("Clarification phase");
    expect(body).toContain("Autonomous phase");
  });

  test("has the four steps (clarify → plan → execute → review)", () => {
    expect(body).toMatch(/Step 1: Clarify/);
    expect(body).toMatch(/Step 2: Plan/);
    expect(body).toMatch(/Step 3: Execute/);
    expect(body).toMatch(/Step 4: Review/);
  });

  test("instructs to run gh-issue-fetch.sh first", () => {
    expect(body).toContain("gh-issue-fetch.sh");
  });

  test("instructs bun install for worktree bootstrap (R6)", () => {
    expect(body).toContain("bun install");
  });

  test("constraint: Fixes #N in commit message", () => {
    expect(body).toContain("Fixes #");
  });

  test("constraint: just integrate-into-main (not direct push)", () => {
    expect(body).toContain("just integrate-into-main");
    expect(body).toContain("Do NOT push directly");
  });

  test("constraint: squash commits into one", () => {
    expect(body.toLowerCase()).toContain("squash");
  });

  test("references the quality-review skill (not a stale .agents path)", () => {
    expect(body).toContain("quality-review");
    // The old seed-prompt referenced .agents/skills/quality-review/SKILL.md;
    // the new skill should reference the skill by name, not a stale path.
    expect(body).not.toContain(".agents/skills/quality-review/SKILL.md");
  });

  test("references @skill:implement-issue as entry point in description", () => {
    expect(body).toContain("@skill:implement-issue");
  });

  test("has polytoken: true frontmatter (templating enabled)", () => {
    expect(body).toMatch(/^---[\s\S]*?polytoken:\s*true[\s\S]*?---/);
  });

  test("uses plan-reviewer subagent in plan step", () => {
    expect(body).toContain("plan-reviewer");
  });

  test("mentions jj-resolve-conflicts skill for conflict handling", () => {
    expect(body).toContain("jj-resolve-conflicts");
  });
});
