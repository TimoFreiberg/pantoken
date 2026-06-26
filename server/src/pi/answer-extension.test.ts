// Chunk 4 (docs/PLAN-self-contained-extensions.md): the ported answer extension is
// pilot's third owned extension (after session-namer + tasklist). The hardest port —
// it owns the `qna` host-UI seam (D2 tracked risk). Mirrors session-namer/tasklist's
// loader tests: drives the REAL pi `DefaultResourceLoader` with the answer path — the
// exact code path pi-driver.ts `warmUp` hands it — pointed at a throwaway agentDir (no
// `.pi/extensions`, so nothing else loads) and asserts:
//   a. the extension loads (no error) and exports a valid factory;
//   b. it registers the `background-model` flag (the D2/[OPEN F] channel the extension
//      reads pilot's backgroundModel setting through — same as session-namer, since the
//      `/answer` extraction path uses the background model for question extraction);
//   c. it registers its `answer` tool + the `/answer` command + the `ctrl+.`
//      shortcut — the three affordances the dotfiles version had;
//   d. pi stamps the `additionalExtensionPaths` source metadata
//      (source:"cli", scope:"temporary", origin:"top-level") — the raw shape the
//      driver's `listExtensions` re-projects to source:"Pilot" (D3);
//   e. the frontmatter `@pilot` block parses to the expected description (D3).
//
// The mock driver never calls createAgentSessionServices, so a mock-driver e2e can't
// exercise the `additionalExtensionPaths` wiring — driving the real loader is the
// faithful substitute (same as the other two ports' loader tests). The extension's
// runtime behaviour — the `qna` seam (ctx.ui.qna), the structured-extraction model call,
// crash recovery — needs a live pi session + model auth and is out of unit reach; the
// qna seam is instead pinned by the compile/runtime canary `ui-bridge-coupling.test.ts`
// (qna NOT on the typed ExtensionUIContext; PiUiBridge exposes it), and the failure-
// philosophy guards are reviewed in the source, not asserted here.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { pilotExtensionDescription } from "./pi-driver.js";

// The same pilot-owned, repo-root-absolute resolution pi-driver.ts uses (it builds its
// PILOT_OWNED_EXTENSIONS map from PILOT_OWNED_EXTENSION_NAMES the same way). Hardcoded
// here rather than imported because the path map isn't exported from pi-driver.ts — and
// re-exporting an internal path constant would outlive its purpose. If these drift, the
// driver's listExtensions (which reads the same file) would surface a load error first.
const ANSWER_PATH = resolve(
  import.meta.dir,
  "../../../pilot/extensions/answer.ts",
);

// A throwaway agentDir with NO `.pi/extensions` — so user-scope auto-discovery finds
// nothing and only the answer extension (via additionalExtensionPaths) loads. Built per
// test so settings never leak across cases.
function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-answer-test-"));
}

describe("Chunk 4: answer pilot extension via additionalExtensionPaths", () => {
  test("(a) the extension loads and exports a valid factory", async () => {
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [ANSWER_PATH],
    });
    await loader.reload();

    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);

    const answer = extensions.find((e) => e.path === ANSWER_PATH);
    expect(answer).toBeDefined();
    // A factory was called (the `tools` Map is populated by registerTool inside it).
    expect(answer?.tools.size).toBeGreaterThan(0);
  });

  test("(b) it registers the `background-model` flag (the D2/[OPEN F] channel)", async () => {
    // The `/answer` extraction path resolves the background-model spec (the D2 setting,
    // threaded in warmUp) for its question-extraction model call — same channel
    // session-namer uses. The extension registers it so ctx.getFlag can read it; without
    // registration getFlag returns undefined (pi's loader gates flag reads on the
    // caller's own registration, and the per-extension namespace means session-namer
    // registering the same name independently is fine).
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [ANSWER_PATH],
    });
    await loader.reload();

    const answer = loader
      .getExtensions()
      .extensions.find((e) => e.path === ANSWER_PATH);
    expect(answer?.flags.has("background-model")).toBe(true);
    const flag = answer?.flags.get("background-model");
    expect(flag?.type).toBe("string");
  });

  test("(c) it registers the answer tool + /answer command + ctrl+. shortcut", async () => {
    // The three affordances the dotfiles version had. Asserting these (not just the
    // flag) is the faithful "it wired itself up" check for this extension: the `answer`
    // tool (LLM-callable), the `/answer` command (extraction from last message), and the
    // `ctrl+.` shortcut bound to the same handler.
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [ANSWER_PATH],
    });
    await loader.reload();

    const answer = loader
      .getExtensions()
      .extensions.find((e) => e.path === ANSWER_PATH);
    expect(answer?.tools.has("answer")).toBe(true);
    expect(answer?.tools.size).toBe(1);
    expect(answer?.commands.has("answer")).toBe(true);
    expect(answer?.shortcuts.has("ctrl+.")).toBe(true);
  });

  test("(d) source surfaces as source:'cli', scope:'temporary', origin:'top-level'", async () => {
    // This is the raw metadata resolveExtensionSources stamps on CLI-provided paths.
    // pi-driver's `listExtensions` re-projects this to source:"Pilot" (D3) — the raw
    // shape here is what that projection keys off (the owned-path match + the scope).
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [ANSWER_PATH],
    });
    await loader.reload();

    const answer = loader
      .getExtensions()
      .extensions.find((e) => e.path === ANSWER_PATH);
    expect(answer?.sourceInfo.source).toBe("cli");
    expect(answer?.sourceInfo.scope).toBe("temporary");
    expect(answer?.sourceInfo.origin).toBe("top-level");
  });

  test("(e) the @pilot frontmatter parses to the expected description (D3)", async () => {
    // The driver's listExtensions parses the leading `/** @pilot … description: … */`
    // block to surface a description on the Settings row. Call the PRODUCTION parser
    // (pilotExtensionDescription) directly so a regex drift in it is caught here, not
    // just a stale copy.
    const desc = pilotExtensionDescription(ANSWER_PATH);
    expect(desc).toBe(
      "Interactive Q&A widget — the agent asks questions via a structured form, optionally extracting them from its last message.",
    );
  });
});
