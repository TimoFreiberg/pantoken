import { expect, test, type Page } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// @-reference autocomplete: files (the original @-file mention), plus the kind-aware
// picker added on top — skills (`@skill:`/`@s:`), subagents (`@subagent:`/`@a:`),
// models (`@model:`/`@m:`), and the sigil rows that narrow a bare/partial query into
// one of those kinds. Prompts stay plain text; the picker only ever inserts a
// canonical `@…` token into the textarea.
//
// Also covers resolution feedback (Stage 6): the daemon reports which `@`-references
// it resolved out of a sent prompt (PromptAccepted.resolved_references) or a drained
// queue item (PendingTurnInputDrained.resolved_references), and warns when a queued
// item is dropped for a reference it couldn't resolve (PendingTurnInputDiscarded.
// missing_references). The mock driver fakes this deterministically: `mock_driver.rs`'s
// `parse_at_references` scans the sent text for `@skill:`/`@subagent:`/`@model:`/known
// file tokens.

const ta = (page: Page) => page.locator(".composer-wrap textarea");
const menu = (page: Page) => page.getByTestId("at-menu");
const row = (page: Page, ref: string) =>
  menu(page).locator(`[data-ref="${ref}"]`);

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Flow: open the skill picker, accept a skill, then narrow via the @s: shorthand —
// both the long and shorthand sigils canonicalize to `@skill:<name>` on Enter.
test("skill picker: @skill: lists skills and @s: narrows; both insert the canonical long sigil", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "skill:debug")).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:debug ");

  // The shorthand `@s:` narrows to journal only; the canonical form is always the long
  // sigil, regardless of the shorthand typed.
  await box.fill("");
  await box.click();
  await page.keyboard.type("@s:jou");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
  await expect(row(page, "skill:debug")).toHaveCount(0);
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:journal ");
});

// Flow: open the subagent picker and accept an entry — inserts `@subagent:<name>`.
test("subagent picker: @a: lists the available subagents and accepts the canonical form", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@a:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "subagent:reviewer")).toBeVisible();
  await expect(row(page, "subagent:explorer")).toBeVisible();
  await row(page, "subagent:reviewer").click();
  await expect(box).toHaveValue("@subagent:reviewer ");
});

// Flow: open the model picker, narrow with the shorthand's partial, and accept —
// inserts the canonical `@model:<modelId>` plus the model's default effort level.
test("model picker: @m: lists models, narrows by partial, and accepts canonical modelId + default effort", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@m:");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "model:anthropic/claude-opus-4-8")).toBeVisible();
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toBeVisible();
  await expect(row(page, "model:openai/gpt-5")).toBeVisible();

  // Narrow with the shorthand's partial, then accept — canonical `@model:<modelId>`
  // (the full registry name) regardless of the `m:` shorthand used to get there,
  // plus the model's default effort level in a `(<level>)` suffix (gpt-5 default = medium).
  await page.keyboard.type("gpt");
  await expect(row(page, "model:openai/gpt-5")).toBeVisible();
  await expect(row(page, "model:anthropic/claude-opus-4-8")).toHaveCount(0);
  await box.press("Enter");
  await expect(box).toHaveValue("@model:openai/gpt-5(medium) ");
});

// Each query below is a case-varied, non-contiguous subsequence. Acceptance still
// uses the same canonical long sigils and model effort suffix as contiguous matches.
test("fuzzy shorthand picks canonical skill, subagent, and model references", async ({
  page,
}) => {
  const box = ta(page);

  await box.click();
  await page.keyboard.type("@s:Dg");
  await expect(row(page, "skill:debug")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:debug ");

  await box.fill("");
  await box.click();
  await page.keyboard.type("@a:RvR");
  await expect(row(page, "subagent:reviewer")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@subagent:reviewer ");

  await box.fill("");
  await box.click();
  await page.keyboard.type("@m:OI5");
  await expect(row(page, "model:openai/gpt-5")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@model:openai/gpt-5(medium) ");
});

// Flow: a bare query that matches files but also offers a kind sigil row — accepting
// the sigil row narrows the menu into that kind's full list (keep-narrowing mechanic).
test("sigil row: @sk offers the skill: sigil after file matches; accepting it narrows into the skill list", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@sk");
  await expect(menu(page)).toBeVisible();
  // "docs/ADR-desktop-shell.md" contains "sk" (deSKtop) — a genuine file match — and
  // the skill: sigil is offered right after it (sigils always sort last).
  await expect(row(page, "file:docs/ADR-desktop-shell.md")).toBeVisible();
  const sigil = row(page, "sigil:skill:");
  await expect(sigil).toBeVisible();

  // Enter accepts the highlighted row; arrow down to the sigil (it's the last row).
  const count = await menu(page).locator("[data-ref]").count();
  for (let i = 0; i < count - 1; i++) await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("@skill:");
  // The menu recomputed to the skill kind's full list — same keep-narrowing mechanic
  // as a directory "/".
  await expect(row(page, "skill:debug")).toBeVisible();
  await expect(row(page, "skill:journal")).toBeVisible();
});

// Flow: Escape dismisses the @-reference menu without changing the draft.
test("Escape dismisses the @-reference menu without changing the draft", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(box).toHaveValue("@skill:");
});

// Flow: [ and ] step a highlighted model row's reasoning level — a multi-level model
// wraps and clamps, and a single-level model clamps at the top then unsets past the
// only level; accepting appends (level) or nothing.
test("model reasoning: [ and ] step the reasoning level — multi-level wraps, single-level clamps and unsets", async ({
  page,
}) => {
  // Narrow to the single leveled model claude-sonnet-4-6 (mock fixture:
  // thinkingLevels off/low/medium/high — server/pantoken-server/src/mock_driver.rs).
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@m:sonnet");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toBeVisible();

  // The row seeds to the model's defaultThinkingLevel (medium) before any keypress.
  await expect(
    row(page, "model:anthropic/claude-sonnet-4-6"),
  ).toContainText("reasoning: medium");

  // ] steps up from the seeded default: "medium" -> "high".
  await box.press("]");
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toContainText(
    "reasoning: high",
  );
  // ] again clamps at the top ("high").
  await box.press("]");
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toContainText(
    "reasoning: high",
  );
  // [ steps back down: "high" -> "medium".
  await box.press("[");
  await expect(row(page, "model:anthropic/claude-sonnet-4-6")).toContainText(
    "reasoning: medium",
  );

  await box.press("Enter");
  await expect(box).toHaveValue("@model:anthropic/claude-sonnet-4-6(medium) ");

  // deepseek-v4-flash's only thinking level is "off" (mock fixture), which is also
  // its defaultThinkingLevel — so the row seeds to "off" on highlight.
  await box.fill("");
  await box.click();
  await page.keyboard.type("@m:deepseek");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).toBeVisible();

  // The row seeds to the default "off" immediately.
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).toContainText(
    "reasoning: off",
  );
  // ] clamps at the top (the only level) instead of wrapping.
  await box.press("]");
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).toContainText(
    "reasoning: off",
  );
  // A second ] still clamps.
  await box.press("]");
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).toContainText(
    "reasoning: off",
  );
  // [ steps back past the only level, to unset — the reasoning text disappears.
  await box.press("[");
  await expect(row(page, "model:deepseek/deepseek-v4-flash")).not.toContainText(
    "reasoning:",
  );

  await box.press("Enter");
  // No level chosen at accept time — the terminal model gets the standard trailing space.
  await expect(box).toHaveValue("@model:deepseek/deepseek-v4-flash ");
  expect(
    await box.evaluate((el: HTMLTextAreaElement) => ({
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    })),
  ).toEqual({ selectionStart: 34, selectionEnd: 34 });
});

// Flow: [ and ] on a non-model row type the character into the draft instead of being
// swallowed for reasoning-level stepping.
test("key passthrough: [ and ] on a non-model row type into the draft instead of being swallowed", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  // The first skill row ("debug") is highlighted by default — a skill row, not a
  // model row, so [ ] must NOT be intercepted for reasoning-level stepping.
  await expect(row(page, "skill:debug")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await box.press("[");
  await expect(box).toHaveValue("@skill:[");
  await box.press("]");
  await expect(box).toHaveValue("@skill:[]");
});

// External paths (`@~/`, `@/`, `@../`) browse the server's filesystem OUTSIDE the
// project — the mock's synthetic external tree (server/pantoken-server/src/mock_driver.rs
// `mock_external_tree()`), not the local file index. Every case here always round-trips
// through the debounced server query (Composer.svelte's always-fire-for-external effect),
// so assertions rely on Playwright's auto-retrying `expect` rather than a fixed wait.
// Keyboard accepts throughout — mouse accepts have a known cursor-resync quirk.

// Flow: browse the synthetic external home — list dirs-first with the hidden dotfile
// absent, narrow to projects/, then drill into projects/ and accept readme.md.
test("external home: @~/ lists dirs-first, @~/proj narrows to projects/, and drilling in accepts readme.md", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
  await expect(row(page, "file:~/notes.md")).toBeVisible();
  await expect(row(page, "file:~/todo.txt")).toBeVisible();
  await expect(row(page, "file:~/.secrets")).toHaveCount(0);

  // Narrow to the projects/ directory only.
  await page.keyboard.type("proj");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
  await expect(row(page, "file:~/notes.md")).toHaveCount(0);
  await expect(row(page, "file:~/todo.txt")).toHaveCount(0);

  // Only "~/projects" matches "proj" — it's the sole (and default-highlighted) row.
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("@~/projects/");

  // The menu recomputed to `~/projects`'s children — same keep-narrowing mechanic as a
  // project-mode directory `/`.
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects/blog")).toBeVisible();
  await expect(row(page, "file:~/projects/pantoken")).toBeVisible();
  await expect(row(page, "file:~/projects/readme.md")).toBeVisible();

  // Dirs sort first, alphabetically (blog, pantoken), then the file (readme.md) —
  // arrow down twice from the default-highlighted first row to reach it.
  await box.press("ArrowDown");
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("@~/projects/readme.md ");
});

// Flow: the parent-relative (@../) and root-anchored (@/etc/) external path fixtures
// both list their entries through the server query.
test("external anchors: @../ lists parent-relative fixtures and @/etc/ lists the root-anchored fixture", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@../");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:../sibling-project")).toBeVisible();
  await expect(row(page, "file:../NOTES.md")).toBeVisible();

  await box.fill("");
  await box.click();
  await page.keyboard.type("@/etc/");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:/etc/hosts")).toBeVisible();
});

// Shift+Tab ignore-rules toggle (polytoken TUI parity): while the picker is open, it
// reveals hidden dotfiles and gitignored entries in BOTH project and external modes.
// The mock's `.env`/`dist/bundle.js` (project) and `~/.secrets` (external) fixtures are
// deliberately absent from the always-visible lists so the toggle has something of its
// own to reveal (server/pantoken-server/src/mock_driver.rs `mock_ignored_files()` /
// `mock_external_tree()`).

// Flow: Shift+Tab reveals hidden fixtures in project mode and external mode, and a
// second Shift+Tab hides them again — the ignore-toggle consumes the key so the facet
// does not rotate.
test("Shift+Tab ignore-toggle: reveals hidden fixtures in project and external modes, and toggles back off", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@.env");
  // Zero local matches: `.env` is a path-prefix match for the hidden `.env` fixture,
  // but under the fuzzy subsequence matcher (#63) it matches no visible fixture — no
  // visible path starts with `.` (so the `.`→`e`→`n`→`v` subsequence can't anchor).
  // The menu stays open with "No matches" (issue #53: always-visible in @-context,
  // so the footer/hotkeys — including ⇧Tab — are reachable without a "surprise"
  // reveal). This is the case Shift+Tab must work from: the menu is already open.
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");

  await box.press("Shift+Tab");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:.env")).toBeVisible();
  await expect(menu(page)).toContainText("ignored files shown");
  // Coexist (issue #19): the ignore-toggle consumed Shift+Tab, so the facet
  // must NOT have also rotated.
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");

  // Shift+Tab again hides it — back to zero matches, menu still open with "No matches".
  await box.press("Shift+Tab");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");

  // External mode: @~/ then Shift+Tab reveals the hidden ~/.secrets fixture.
  await box.fill("");
  await box.click();
  await page.keyboard.type("@~/");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/.secrets")).toHaveCount(0);
  await expect(menu(page)).toContainText("⇧Tab ignored files");

  await box.press("Shift+Tab");
  await expect(row(page, "file:~/.secrets")).toBeVisible();
  await expect(menu(page)).toContainText("ignored files shown");
  // Coexist (issue #19): the ignore-toggle consumed Shift+Tab, so the facet
  // must NOT have also rotated.
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");

  await box.press("Shift+Tab");
  await expect(row(page, "file:~/.secrets")).toHaveCount(0);
});

// Issue #53: the @-menu is always visible while the cursor is inside an @-token, even
// when the query matches nothing — showing a "No matches" body and the pinned hotkey
// footer, so there's no "surprise Shift+Tab" from a hidden menu.

// Flow: an empty @-menu stays open showing "No matches", ignores arrow keys, and
// Escape dismisses it without changing the draft.
test("empty @-menu: stays open with 'No matches', ignores arrow keys, and Escape dismisses", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@zzz");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
  // The footer/hotkeys stay visible below the empty body.
  await expect(menu(page)).toContainText("↑↓ navigate");

  // ArrowUp/ArrowDown on an empty @-menu is a no-op (no crash, menu stays open).
  // Re-assert the "No matches" body before the first arrow key — the arrow-key
  // sub-flow's own initial precondition (preserved verbatim from its source test).
  await expect(menu(page)).toContainText("No matches");
  await box.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");
  await box.press("ArrowUp");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toContainText("No matches");

  // Escape dismisses the always-open empty menu.
  await box.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

// Flow: Enter on an empty @-menu falls through to submit (does not swallow) — the
// draft with the literal @zzz is sent and appears in the transcript.
test("empty @-menu: Enter falls through to submit (does not swallow)", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@zzz");
  await expect(menu(page)).toContainText("No matches");
  // Enter must NOT be swallowed by the empty menu — it falls through to normal
  // submit. The draft (with the literal @zzz) is sent: the composer clears and
  // the prompt text appears in the transcript, ending the @-context.
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(page.getByText("@zzz").first()).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
});

// Flow: skill/subagent/model rows render a front `kind:` prefix and no right-edge badge.
test("row rendering: skill/subagent/model rows show a front kind: prefix and no right-edge badge", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  // The skill row's visible text starts with the front "skill:" prefix (mirroring the
  // search term), and the old right-edge .kind-badge is gone.
  await expect(row(page, "skill:debug")).toContainText("skill:debug");
  await expect(menu(page).locator(".kind-badge")).toHaveCount(0);

  await box.fill("");
  await box.click();
  await page.keyboard.type("@a:");
  await expect(row(page, "subagent:reviewer")).toContainText("subagent:reviewer");
  await expect(menu(page).locator(".kind-badge")).toHaveCount(0);

  await box.fill("");
  await box.click();
  await page.keyboard.type("@m:");
  // Model rows show "model:provider/modelId" at the front.
  await expect(row(page, "model:openai/gpt-5")).toContainText("model:openai/gpt-5");
  await expect(menu(page).locator(".kind-badge")).toHaveCount(0);
});

// Flow: the pinned footer stays visible when scrolling the list to both the bottom and
// the top — it lives outside the scroll region.
test("pinned footer: stays visible when scrolling the list to the bottom and back to the top", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  // `@s` matches enough skills + files to overflow the menu's max-height, so the
  // list scrolls. The footer is pinned outside the scroll region and must remain
  // visible at both the bottom and the top of the scroll range — if it were inside
  // the scroll area (the old layout), scrolling down would push it out of view.
  await page.keyboard.type("@s");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).locator("[data-ref]").first()).toBeVisible();
  const list = menu(page).locator(".list");
  // Scroll to the bottom first — the footer must still be visible there.
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(menu(page).getByText("↑↓ navigate")).toBeVisible();
  // Then scroll back to the top — the footer must still be visible there too.
  await list.evaluate((el) => (el.scrollTop = 0));
  await expect(menu(page).getByText("↑↓ navigate")).toBeVisible();
});

// Flow: after Shift+Tab toggles ignored files on, plain (unshifted) Tab still accepts
// the highlighted row — the toggle does not break accept.
test("Tab accept: plain Tab still accepts the highlighted row after Shift+Tab toggled ignored files on", async ({
  page,
}) => {
  const box = ta(page);
  await box.click();
  await page.keyboard.type("@~/");
  await expect(menu(page)).toBeVisible();

  // Shift+Tab toggles the ignore state without accepting anything — the draft stays put.
  await box.press("Shift+Tab");
  await expect(row(page, "file:~/.secrets")).toBeVisible();
  await expect(box).toHaveValue("@~/");

  // Dirs sort first ("~/projects"), then dotfile-then-alpha files: ~/.secrets, ~/notes.md,
  // ~/todo.txt — arrow down once from the default-highlighted first row to reach .secrets,
  // then accept with plain (unshifted) Tab.
  await box.press("ArrowDown");
  await box.press("Tab");
  await expect(box).toHaveValue("@~/.secrets ");
});

// Flow: Shift+Tab in a skill takeover (no ignored-files notion) opens the facet menu —
// no toggle, no accept, no facet rotation; Escape aborts without changing the facet.
test("Shift+Tab in a skill takeover opens the facet menu (no toggle, no accept, no rotation)", async ({
  page,
}) => {
  // Skill/subagent/model takeovers have no notion of "ignored files", so the footer
  // omits the ⇧Tab hint and the ignore-toggle doesn't apply. Shift+Tab now opens
  // the facet menu on the current facet (no rotation, no commit) instead of
  // falling through to browser focus-nav (issue #50). The draft text is
  // unchanged — no accept happened.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  const box = ta(page);
  await box.click();
  await page.keyboard.type("@skill:");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).not.toContainText("⇧Tab");

  await box.press("Shift+Tab");
  // Not accepted (the draft would read "@skill:debug"), not modified at all…
  await expect(box).toHaveValue("@skill:");
  // …and the facet menu opened (no rotation — badge still "Execute").
  await expect(badge).toHaveText("Execute");
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();

  // Close the facet menu — Escape aborts without changing the facet.
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Execute");
});

// Stale-while-revalidate (issue #17): when typing narrows a server-backed query, the
// menu must NOT blank out and reappear on every keystroke. It should keep showing the
// previous results, re-filtered against the new query, until fresh server results arrive.
// The mock driver's list_files is synchronous, so we intercept the WS `fileList` frame
// and hold it to make the in-flight window observable.
//
// Special boot: routeWebSocket must be installed BEFORE navigation, so this flow does a
// second reset+reload inside the test body after installing the gate (the file-level
// beforeEach already booted once without the gate).
test("no flicker: narrowing @~/p keeps re-filtered rows visible during the in-flight window", async ({
  page,
}) => {
  // A flag the WS handler reads to decide whether to delay fileList responses. Toggled
  // from the test to gate the in-flight window.
  let delayFileList = false;
  // Stored in an array so TS doesn't narrow the type to `never` (the assignment happens
  // inside the routeWebSocket closure, which TS's control-flow analysis can't track).
  const pendingFileList: Array<() => void> = [];

  // Install BEFORE navigation: routeWebSocket patches the page's WebSocket at document init.
  await page.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const data = message as string;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "fileList" && delayFileList) {
          // Hold the response until the test releases it.
          pendingFileList.push(() => ws.send(data));
          return;
        }
      } catch {
        // non-JSON — forward untouched
      }
      ws.send(data);
    });
    ws.onMessage((message) => server.send(message as string));
  });

  await gotoFresh(page);
  const box = ta(page);
  await box.click();

  // Type @~/p — the first response arrives (no delay yet), showing ~/projects.
  await page.keyboard.type("@~/p");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
  await expect(row(page, "file:~/notes.md")).toHaveCount(0);

  // Now arm the delay so the NEXT keystroke's response is held in-flight.
  delayFileList = true;

  // Type "r" → @~/pr. The fresh response is held, but the stale-while-revalidate cache
  // re-filters the previous results by "pr" — ~/projects still matches, so the menu
  // stays visible with a non-zero row count.
  await page.keyboard.type("r");
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();

  // Release the held response — fresh results arrive and replace the stale-filtered display.
  delayFileList = false;
  for (const send of pendingFileList.splice(0)) send();
  await expect(menu(page)).toBeVisible();
  await expect(row(page, "file:~/projects")).toBeVisible();
});

// ── Resolution feedback (absorbed from resolved-references.e2e.ts) ──

// Flow: a sent prompt with recognized @-mentions shows resolved-reference chips, and a
// plain prompt with no @-mentions shows none.
test("resolved references: recognized @-mentions show chips on the sent row; a plain prompt shows none", async ({
  page,
}) => {
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("Ask @skill:debug to review @README.md please.");
  await page.getByRole("button", { name: "Send" }).click();

  const sentRow = page.locator(".row.user", {
    hasText: "Ask @skill:debug to review @README.md please.",
  });
  await expect(sentRow).toBeVisible();

  const chips = sentRow.locator(".ref-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText("skill");
  await expect(chips.nth(0)).toContainText("debug");
  await expect(chips.nth(0)).toHaveAttribute(
    "title",
    "Resolved reference: skill debug",
  );
  await expect(chips.nth(1)).toContainText("file");
  await expect(chips.nth(1)).toContainText("README.md");

  // A prompt with no recognized @-mentions shows no chips.
  await composer.fill("Just a plain message, nothing special.");
  await page.getByRole("button", { name: "Send" }).click();

  const plainRow = page.locator(".row.user", {
    hasText: "Just a plain message, nothing special.",
  });
  await expect(plainRow).toBeVisible();
  await expect(plainRow.locator(".ref-chip")).toHaveCount(0);
});

// Flow: discarding a queued item for a missing reference drops it (no promotion to a
// user turn) and shows a visible warning naming the missing references.
test("resolved references: discarding a queued item for a missing reference shows a visible warning", async ({
  page,
}) => {
  await drive(page, "queue");
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");

  await drive(page, "discardqueue");

  // The queue lost its head item…
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 1");
  await expect(page.getByTestId("queue-tray")).not.toContainText(
    "Please inspect the failing test first.",
  );
  // …and it did NOT get promoted into a user turn (contrast "deliverqueue").
  await expect(
    page.locator(".row.user", {
      hasText: "Please inspect the failing test first.",
    }),
  ).toHaveCount(0);

  // A visible warning names the missing references.
  const notice = page.locator(".notice.warning");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Queued message dropped");
  await expect(notice).toContainText('skill "ghost-skill"');
  await expect(notice).toContainText('file "ghost-file.md"');
});
