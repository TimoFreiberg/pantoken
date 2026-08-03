import { expect, test, type Page } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  openSidebar,
  waitForSettledWorkBlocks,
  wheelUp,
  keyboardScrollToPosition,
  scrollUpViaKeyboard,
} from "./helpers.js";

/** Build `turns` reply turns (plus the greeting) and wait for `turns + 1` settled
 *  work blocks. Shared by the prompt-nav tests that each previously rebuilt a
 *  5-turn transcript via inline `for` loops. */
async function buildMultiTurn(page: Page, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, turns + 1);
}

/** True when the scroller sits at prompt `idx`'s block-start target.
 *  `scrollIntoView` clamps at the max scroll offset, so a prompt too near the
 *  tail to reach the top settles at the bottom — `min(within, max)` models that. */
function atPrompt(page: Page, idx: number) {
  return page.evaluate((i) => {
    const sc = document.querySelector(".scroller") as HTMLElement | null;
    const row = document.querySelectorAll(".row.user")[i] as HTMLElement | undefined;
    if (!sc || !row) return false;
    const within =
      row.getBoundingClientRect().top -
      sc.getBoundingClientRect().top +
      sc.scrollTop;
    const max = sc.scrollHeight - sc.clientHeight;
    return Math.abs(sc.scrollTop - Math.min(within, max)) < 4;
  }, idx);
}

/** Require the indexed prompt target to remain correct across two layout polls. */
async function waitForPrompt(page: Page, idx: number): Promise<void> {
  await expect.poll(() => atPrompt(page, idx), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => atPrompt(page, idx), { timeout: 10_000 }).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: edit-tool card: collapsed +N/−M badge, expands to a @pierre/diffs render
test("edit-tool card: collapsed +N/−M badge, expands to a @pierre/diffs render", async ({
  page,
}) => {
  await drive(page, "editdiff");
  const card = page.locator(".tool", { hasText: "Edit file" });
  await expect(card).toBeVisible();
  // Collapsed badge shows added/removed line counts (the edit changes one line).
  const counts = card.locator(".counts");
  await expect(counts).toContainText("+1");
  await expect(counts).toContainText("1");
  await expect(counts).toBeVisible();

  // The collapse/expand toggle is a disclosure control — no tooltip needed
  // (chevron + tool name make the function obvious). It keeps aria-expanded.
  await expect(card.locator(".head")).toHaveAttribute("aria-expanded", "false");
  await expect(card.locator(".head")).toHaveAccessibleName(
    /completed.*Edit file.*took \d+ms.*1 added.*1 removed/i,
  );

  // Expanding mounts the pierre diff into a shadow root (self-contained HTML).
  await card.locator(".head").click();
  await expect
    .poll(
      async () =>
        card.evaluate((el) =>
          [...el.querySelectorAll("*")].some((n) => !!n.shadowRoot),
        ),
      { timeout: 8000 },
    )
    .toBe(true);
  await expect(card.locator(".diff-note")).toHaveCount(0);
});

// Journey: oversized edit preview is bounded while raw arguments and result copy exactly
test("oversized edit preview is bounded while raw arguments and result copy exactly", async ({
  page,
}) => {
  await drive(page, "editbounds");
  const card = page.locator(".tool", { hasText: "Oversized edit" });
  await expect(card.locator(".counts")).toHaveAccessibleName(
    "601 added, 601 removed",
  );
  await card.locator(".head").click();
  await expect(card.locator(".diff-note")).toContainText("Preview truncated");
  await expect
    .poll(
      () =>
        card.evaluate((el) => {
          const host = [...el.querySelectorAll<HTMLElement>("*")].find(
            (node) => node.shadowRoot,
          );
          return host?.shadowRoot?.querySelectorAll("*").length ?? 0;
        }),
      { timeout: 8000 },
    )
    .toBeGreaterThan(0);

  const rendered = await card.evaluate((el) => {
    const host = [...el.querySelectorAll<HTMLElement>("*")].find(
      (node) => node.shadowRoot,
    );
    return {
      elements: host?.shadowRoot?.querySelectorAll("*").length ?? 0,
      text: host?.shadowRoot?.textContent ?? "",
    };
  });
  expect(rendered.elements).toBeLessThan(2_500);
  expect(rendered.text).toContain("OLD_PREVIEW_MARKER");
  expect(rendered.text).toContain("NEW_PREVIEW_MARKER");
  expect(rendered.text).not.toContain("PATCH_PREFIX_MARKER");
  expect(rendered.text).not.toContain("OLD_EDIT_TAIL");
  expect(rendered.text).not.toContain("NEW_EDIT_TAIL");
  expect(rendered.text).not.toContain("PATCH_TAIL");

  await card
    .getByRole("button", { name: "Copy full arguments", exact: true })
    .click();
  const copiedArguments = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  ) as { edits: Array<{ oldText: string; newText: string }> };
  expect(copiedArguments.edits[0]?.oldText).toBe(
    `OLD_PREVIEW_MARKER\n${"old line\n".repeat(599)}OLD_EDIT_TAIL`,
  );
  expect(copiedArguments.edits[0]?.newText).toBe(
    `NEW_PREVIEW_MARKER\n${"new line\n".repeat(599)}NEW_EDIT_TAIL`,
  );

  await card
    .getByRole("button", { name: "Copy full result", exact: true })
    .click();
  const copiedResult = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  ) as {
    content: Array<{ text: string }>;
    details: { patch: string };
  };
  expect(copiedResult.content[0]?.text).toBe("edit completed RESULT_TAIL");
  expect(copiedResult.details.patch).toBe(
    `--- a/src/oversized.ts\n+++ b/src/oversized.ts\n@@ -1 +1 @@\n-PATCH_PREFIX_MARKER${"P".repeat(25_000)}\n+replacement\nPATCH_TAIL`,
  );
});

// Journey: ordinary rich edit patch renders instead of the input-derived sides
test("ordinary rich edit patch renders instead of the input-derived sides", async ({
  page,
}) => {
  await drive(page, "editpatch");
  const card = page.locator(".tool", { hasText: "Rich patch edit" });
  await card.locator(".head").click();
  await expect(card.locator(".diff-note")).toHaveCount(0);
  await expect
    .poll(
      () =>
        card.evaluate((el) => {
          const host = [...el.querySelectorAll<HTMLElement>("*")].find(
            (node) => node.shadowRoot,
          );
          return host?.shadowRoot?.textContent ?? "";
        }),
      { timeout: 8000 },
    )
    .toContain("PATCH_BRANCH_OLD");
  const shadowText = await card.evaluate((el) => {
    const host = [...el.querySelectorAll<HTMLElement>("*")].find(
      (node) => node.shadowRoot,
    );
    return host?.shadowRoot?.textContent ?? "";
  });
  expect(shadowText).toContain("PATCH_BRANCH_NEW");
  expect(shadowText).not.toContain("INPUT_SIDE_OLD");
  expect(shadowText).not.toContain("INPUT_SIDE_NEW");
});

// Journey: large line matrix omits counts and still renders its bounded preview promptly
test("large line matrix omits counts and still renders its bounded preview promptly", async ({
  page,
}) => {
  await drive(page, "editcountguard");
  const card = page.locator(".tool", { hasText: "Huge line-count edit" });
  await expect(card).toBeVisible({ timeout: 2_000 });
  await expect(card.locator(".counts")).toHaveCount(0);
  const omitted = card.locator(".counts-omitted");
  await expect(omitted).toHaveText("large edit");
  await expect(omitted).toHaveAccessibleName(
    "Line counts omitted for large edit",
  );
  await expect(omitted).toHaveAttribute(
    "title",
    "Line counts omitted for large edit",
  );

  await card.locator(".head").click();
  await expect
    .poll(
      () =>
        card.evaluate((el) => {
          const host = [...el.querySelectorAll<HTMLElement>("*")].find(
            (node) => node.shadowRoot,
          );
          return host?.shadowRoot?.textContent ?? "";
        }),
      { timeout: 5_000 },
    )
    .toContain("GUARD_OLD_START");
});

// Journey: one-sided edits count safe creations exactly and guard pathological deletions
test("one-sided edits count safe creations exactly and guard pathological deletions", async ({
  page,
}) => {
  await drive(page, "editemptyguards");

  const creation = page.locator(".tool", { hasText: "Large file creation" });
  await expect(creation).toBeVisible({ timeout: 2_000 });
  await expect(creation.locator(".counts")).toHaveAccessibleName(
    "601 added, 0 removed",
  );
  await expect(creation.locator(".counts-omitted")).toHaveCount(0);
  await creation.locator(".head").click();
  await expect
    .poll(
      () =>
        creation.evaluate((el) => {
          const host = [...el.querySelectorAll<HTMLElement>("*")].find(
            (node) => node.shadowRoot,
          );
          return host?.shadowRoot?.textContent ?? "";
        }),
      { timeout: 5_000 },
    )
    .toContain("CREATE_PREVIEW_START");

  const deletion = page.locator(".tool", {
    hasText: "Pathological file deletion",
  });
  await expect(deletion).toBeVisible({ timeout: 2_000 });
  await expect(deletion.locator(".counts")).toHaveCount(0);
  await expect(deletion.locator(".counts-omitted")).toHaveAccessibleName(
    "Line counts omitted for large edit",
  );
  await deletion.locator(".head").click();
  await expect
    .poll(
      () =>
        deletion.evaluate((el) => {
          const host = [...el.querySelectorAll<HTMLElement>("*")].find(
            (node) => node.shadowRoot,
          );
          return host?.shadowRoot?.textContent ?? "";
        }),
      { timeout: 5_000 },
    )
    .toContain("DELETE_PREVIEW_START");
});

// Journey: message timestamps render with an exact-time tooltip
test("message timestamps render with an exact-time tooltip", async ({
  page,
}) => {
  // The greeting already has user + assistant messages with timestamps.
  const times = page.locator("time.ts");
  // The mock driver's deterministic epoch timestamps intentionally have no relative
  // label in the UI (Transcript suppresses implausibly ancient dates), so the
  // <time> node is zero-sized in this fixture. Assert the tooltip contract directly.
  await expect(times.first()).toHaveAttribute("title", /.+/);
  await expect(times.first()).toHaveAttribute("datetime", /.+/);
});

// Journey: desktop turn actions and timestamps reveal as one footer
test("desktop turn actions and timestamps reveal as one footer", async ({
  page,
}) => {
  await waitForSettledWorkBlocks(page, 1);
  await page.mouse.move(0, 0);
  const user = page.locator(".row.user").first();
  const assistant = page.locator(".row.assistant").last();

  for (const [row, footer] of [
    [user, user.locator(".umeta")],
    [assistant, assistant.locator(".meta")],
  ] as const) {
    await expect(footer).toHaveCSS("opacity", "0");
    await row.hover();
    await expect(footer).toHaveCSS("opacity", "1");
    const tags = await footer
      .locator(":scope > *")
      .evaluateAll((nodes) => nodes.map((node) => node.tagName.toLowerCase()));
    expect(tags.at(-1)).toBe("time");
  }
});

// Journey: copy + timestamp show only on the turn-final paragraph
test("copy + timestamp show only on the turn-final paragraph", async ({
  page,
}) => {
  // The greeting turn has TWO assistant paragraphs (one before its tool call, one
  // after). Only the LAST carries the copy button + timestamp; the earlier one is bare.
  // The earlier paragraph lives inside the collapsed work block — reveal it first.
  await expandWork(page);
  const rows = page.locator(".row.assistant");
  await expect(rows).toHaveCount(2);
  const first = rows.first();
  const last = rows.last();
  await expect(first.getByRole("button", { name: "Copy message" })).toHaveCount(
    0,
  );
  await expect(first.locator("time.ts")).toHaveCount(0);
  await expect(
    last.getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
  await expect(last.locator("time.ts")).toHaveCount(1);
});

// Journey: an active turn's paragraph followed by a running tool stays bare
test("an active turn's paragraph followed by a running tool stays bare", async ({
  page,
}) => {
  // Regression: while a turn is still in flight, a paragraph that LOOKS final (it
  // stopped streaming because a tool started after it) must NOT get the copy + timestamp
  // footer — more tools and text can still follow. staleidle leaves exactly that shape:
  // "On it …" paragraph, then a running tool, turn never completes.
  await drive(page, "staleidle");
  const active = page
    .locator(".row.assistant")
    .filter({ hasText: "kicking off a command" });
  await expect(active).toBeVisible();
  await expect(
    active.getByRole("button", { name: "Copy message" }),
  ).toHaveCount(0);
  await expect(active.locator("time.ts")).toHaveCount(0);
  // The PRIOR settled turn keeps its footer — the suppression is scoped to the live turn,
  // not a blanket "hide all footers while anything runs".
  const settled = page
    .locator(".row.assistant")
    .filter({ hasText: "Routes live in" });
  await expect(
    settled.getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
});

// Journey: copy button copies the whole turn's text and shows feedback
test("copy button copies the whole turn's text and shows feedback", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const assistant = page.locator(".row.assistant").last();
  await assistant.hover();
  const copy = assistant.getByRole("button", { name: "Copy message" });
  await expect(copy).toBeVisible();
  await copy.click();
  // Feedback is now an icon swap (copy -> check) + accent tint, flagged by `copied`.
  await expect(copy).toHaveClass(/\bcopied\b/);
  // The clipboard holds BOTH paragraphs of the turn, not just the final block.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("I'll add a lightweight health endpoint");
  expect(copied).toContain("Routes live in");
});

// Journey: copy button fades back out once the pointer leaves the message
test("copy button fades back out once the pointer leaves the message", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // gotoFresh returns mid-replay, while the greeting turn is still active. An active turn
  // keeps its "Worked for Ns" block expanded; runCompleted then collapses it, which yanks
  // the assistant row upward. hover() is one-shot — it parks the cursor at the row's
  // current centre — so a hover taken before that collapse is left stranded off the row,
  // `:hover` drops, and the copy button never animates to opacity 1. Wait for the work
  // block to collapse (aria-expanded="false" ⇒ turn settled, layout final) before hovering.
  await expect(page.getByTestId("work-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const assistant = page.locator(".row.assistant").last();
  const footer = assistant.locator(".meta");
  const copy = assistant.getByRole("button", { name: "Copy message" });
  // Hover reveals the entire action/timestamp footer as one unit.
  await assistant.hover();
  await expect
    .poll(() => footer.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  // Clicking copies but must not pin it visible via lingering :focus-visible;
  // leaving the row in any direction fades it back out.
  await copy.click();
  await page.mouse.move(0, 0);
  await expect
    .poll(() => footer.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("0");
});

// Journey: user prompt footer offers a copy button next to rewind; it copies the prompt
test("user prompt footer offers a copy button next to rewind; it copies the prompt", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const user = page.locator(".row.user").first();
  await user.hover();
  const copy = user.getByRole("button", { name: "Copy message" });
  const branch = user.getByRole("button", { name: "Rewind to this prompt" });
  await expect(copy).toBeVisible();
  await expect(branch).toBeVisible();
  // Copy sits to the LEFT of rewind in the footer (matches the assistant order).
  const copyBox = await copy.boundingBox();
  const branchBox = await branch.boundingBox();
  expect(copyBox).not.toBeNull();
  expect(branchBox).not.toBeNull();
  expect(copyBox!.x).toBeLessThan(branchBox!.x);

  await copy.click();
  await expect(copy).toHaveClass(/\bcopied\b/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const promptText =
    (await user.locator(".bubble").textContent())?.trim() ?? "";
  expect(promptText.length).toBeGreaterThan(0);
  expect(copied).toBe(promptText);
});

// Journey: an armed rewind footer stays visible and interactive off-hover
test("an armed rewind footer stays visible and interactive off-hover", async ({
  page,
}) => {
  const user = page.locator(".row.user").first();
  await user.hover();
  await user.getByRole("button", { name: "Rewind to this prompt" }).click();
  await page.mouse.move(0, 0);
  const footer = user.locator(".umeta");
  await expect(footer).toHaveClass(/armed/);
  await expect(footer).toHaveCSS("opacity", "1");
  await expect(footer).toHaveCSS("pointer-events", "auto");
  await expect(
    user.getByRole("button", { name: "Rewind to this prompt" }),
  ).toBeEnabled();
});

// Journey: no stray working indicator after a turn ends via sessionUpdated (not runCompleted)
test("no stray working indicator after a turn ends via sessionUpdated (not runCompleted)", async ({
  page,
}) => {
  await drive(page, "idle");
  // Wait for the streamed line to finish.
  await expect(
    page.getByText("ends with a status update", { exact: false }),
  ).toBeVisible();
  // The session is idle again — the bottom working indicator must be gone.
  await expect
    .poll(() => page.getByTestId("working-indicator").count())
    .toBe(0);
});

// Journey: tab title mirrors the active session title
test("tab title mirrors the active session title", async ({ page }) => {
  // The greeting snapshot titles the session "Wire up the WebSocket bridge";
  // document.title should reflect it (suffixed with the app name) rather than
  // staying the static "pantoken".
  await expect(page).toHaveTitle("Wire up the WebSocket bridge · pantoken");
});

// Journey: transcript: full markdown renders (headings, table, code, links)
test("transcript: full markdown renders (headings, table, code, links)", async ({
  page,
}) => {
  await drive(page, "markdown");
  // Wait for the markdown turn to settle (final render) before asserting structure.
  const row = page.locator(".row.assistant").last();
  await expect(row.getByRole("button", { name: "Copy message" })).toBeVisible();
  const md = row.locator(".markstream-svelte.markdown-renderer");
  await expect(md.locator("h2")).toHaveText("Markdown showcase");
  await expect(md.locator("h3").first()).toHaveText("A table");
  await expect(md.locator("strong")).toHaveText("bold");
  await expect(md.locator("em")).toHaveText("italic");
  // GFM table — headers + a body cell.
  await expect(md.locator("table th").first()).toHaveText("Feature");
  await expect(md.locator("table td").first()).toHaveText("Headers");
  // Fenced code block renders as <pre> (renderCodeBlocksAsPre, no Monaco peer).
  await expect(md.locator("pre")).toContainText("function greet");
  // Links survive sanitization and are hardened with rel="noopener".
  const link = md.locator("a");
  await expect(link).toHaveAttribute("href", "https://example.com");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

// Journey: transcript: code blocks get a copy button that copies the code
test("transcript: code blocks get a copy button that copies the code", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await drive(page, "markdown");
  const row = page.locator(".row.assistant").last();
  // The fenced code block is wrapped with a pinned copy button (top-right).
  const wrap = row.locator(".code-block", { has: page.locator("pre") });
  await expect(wrap).toBeVisible();
  const pre = wrap.locator("pre");
  await expect(pre).toHaveAttribute("tabindex", "0");
  await expect(pre).toHaveAttribute("aria-label", "Code block");
  await pre.focus();
  // Return via keyboard navigation so :focus-visible, rather than programmatic focus,
  // is the modality under test.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(pre).toBeFocused();
  await expect
    .poll(() =>
      pre.evaluate((el) => ({
        outline: getComputedStyle(el).outlineStyle,
        overscrollX: getComputedStyle(el).overscrollBehaviorX,
        overscrollY: getComputedStyle(el).overscrollBehaviorY,
      })),
    )
    .toEqual({ outline: "solid", overscrollX: "contain", overscrollY: "auto" });
  const copy = wrap.getByRole("button", { name: "Copy code" });
  await expect(copy).toHaveCount(1);
  await copy.click();
  // Post-copy: the button flips to the "Copied" confirmation state.
  await expect(wrap.getByRole("button", { name: "Copied" })).toBeVisible();
  // The clipboard holds the code block's source (not the surrounding prose).
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("function greet(name: string)");
  expect(clip).not.toContain("Markdown showcase");
});

// Journey: transcript: long code blocks stay bounded with all content reachable
test("transcript: long code blocks stay bounded with all content reachable", async ({
  page,
}) => {
  await drive(page, "markdown");
  const pre = page.locator(".row.assistant").last().locator(".code-block pre");
  await pre.locator("code").evaluate((code) => {
    code.textContent = Array.from(
      { length: 239 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    code.append("\n");
    const last = document.createElement("span");
    last.dataset.testid = "last-code-line";
    last.textContent = "line 240";
    code.append(last);
  });

  const initial = await pre.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    viewportBound: Math.min(window.innerHeight * 0.6, 720),
  }));
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
  expect(initial.clientHeight).toBeLessThanOrEqual(initial.viewportBound + 1);

  await pre.focus();
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => pre.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  // Keep paging through the focused region exactly as a keyboard user would. `End`
  // is platform-dependent on a non-editable <pre> (horizontal on WebKit), while
  // PageDown consistently advances this vertical scroll container.
  for (let pageN = 0; pageN < 20; pageN += 1) {
    const atBottom = await pre.evaluate(
      (el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1,
    );
    if (atBottom) break;
    await page.keyboard.press("PageDown");
    // Native keyboard scrolling is animated; let each page movement settle so the
    // browser does not coalesce a burst of synthetic key presses.
    await page.waitForTimeout(100);
  }
  const reachedBottom = await pre.evaluate(
    (el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1,
  );
  expect(reachedBottom).toBe(true);
  await expect(pre.getByTestId("last-code-line")).toBeInViewport();
});

// Journey: shared IconButton normalizes a direct raw SVG to its medium 1em size
test("shared IconButton normalizes a direct raw SVG to its medium 1em size", async ({
  page,
}) => {
  await drive(page, "planview");
  const icon = page.getByTestId("plan-view-toggle").locator(":scope > svg");
  // This source icon asks for 15px, while medium IconButton defines 1em as 16px.
  // The computed size proves direct raw icons are normalized; the Chevron regression
  // separately proves nested shared primitives keep their explicit size API.
  await expect(icon).toHaveAttribute("width", "15");
  await expect(icon).toHaveCSS("width", "16px");
  await expect(icon).toHaveCSS("height", "16px");
});

// Journey: type-to-focus: a printable key focuses the composer
test("type-to-focus: a printable key focuses the composer", async ({
  page,
}) => {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("h");
  await expect(page.locator(".composer-wrap textarea")).toBeFocused();
});

// Journey: binary select renders a Yes/No card with the affirmative as primary
test("binary select renders a Yes/No card with the affirmative as primary", async ({
  page,
}) => {
  await drive(page, "yesno");
  const actions = page.locator('[role="dialog"] .actions.two button');
  await expect(actions).toHaveCount(2);
  // Affirmative ("Allow") is promoted to the primary button on the right,
  // even though it is second in the options array.
  await expect(actions.nth(0)).toHaveText("Don't allow");
  await expect(actions.nth(1)).toHaveText("Allow");
  await expect(actions.nth(1)).toHaveClass(/primary/);
});

// Journey: timeout-bearing dialog shows a countdown and auto-resolves deny-safe
test("timeout-bearing dialog shows a countdown and auto-resolves deny-safe", async ({
  page,
}) => {
  await drive(page, "timeout");
  await expect(page.getByText(/Auto-dismiss in \d+s/)).toBeVisible();
  // After the 3s timeout it auto-resolves to the deny-safe default.
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 8000 });
  await expect(page.getByText("Denied — skipping that step.")).toBeVisible();
});

// Journey: Ctrl/Cmd+Up anchors to the scroll position, not always the last prompt
test("Ctrl/Cmd+Up anchors to the scroll position, not always the last prompt", async ({
  page,
}) => {
  // Build enough turns that early prompts have room to scroll to the top of the viewport.
  await buildMultiTurn(page, 5);
  const count = await page.locator(".row.user").count();
  expect(count).toBeGreaterThanOrEqual(6);
  const last = count - 1;

  // Park user prompt #2 at the top of the viewport, well away from the live tail.
  // Use real wheel input so the input-gated pin registers it as a user action.
  await wheelUp(page, 500);
  // Confirm we're genuinely scrolled up off the tail before pressing the hotkey.
  const gap = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      return sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    });
  await expect.poll(gap).toBeGreaterThan(80);

  // Index of the `.row.user` whose top sits nearest the scroller's top.
  const topRowIndex = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      const sTop = sc.getBoundingClientRect().top;
      let best = -1;
      let dist = Infinity;
      document.querySelectorAll(".row.user").forEach((r, i) => {
        const d = Math.abs(r.getBoundingClientRect().top - sTop);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      return best;
    });

  // ↑ jumps to the prompt at the top of where we're reading (#1, just above the parked
  // #2) — it does NOT yank down to the most recent prompt the way it used to.
  await page.locator(".transcript-wrap").hover();
  await page.getByTestId("prompt-nav-up").press("Enter");
  await expect.poll(topRowIndex).toBeLessThanOrEqual(2);
  const idx = await topRowIndex();
  expect(idx).toBeGreaterThanOrEqual(1); // moved up to an early prompt
  expect(idx).toBeLessThan(last); // and nowhere near the live tail
  expect(await gap()).toBeGreaterThan(80); // didn't scroll back to the bottom

  // Control+ArrowUp is now a live hotkey (scroll-to-top), but the focus gate
  // suppresses it while the composer textarea is focused. The prompt-nav-up
  // button click above moved focus to a <button>, so focus the textarea first
  // to verify the gate suppresses the hotkey (scroll position untouched).
  await page.locator("textarea").focus();
  const scrollTopBefore = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    return sc.scrollTop;
  });
  await page.keyboard.press("Control+ArrowUp");
  const scrollTopAfter = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    return sc.scrollTop;
  });
  expect(scrollTopAfter).toBe(scrollTopBefore);
});

// Journey: Ctrl/Cmd+Up/Down step through user prompts
test("Ctrl/Cmd+Up/Down step through user prompts", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1100);
  // Build several turns so the oldest prompts have enough content below them to scroll to
  // the top (a short final turn can't, which is fine — the stepper clamps there).
  await buildMultiTurn(page, 5);

  const count = await page.locator(".row.user").count(); // greeting + 5 replies
  expect(count).toBeGreaterThanOrEqual(6);
  const last = count - 1;

  // Asserting by scroll position, not prompt text: the reply fixture reuses one
  // prompt string across turns. `atPrompt` is the shared helper above.
  const atBottom = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4;
    });

  // From the live tail, clicking ↑ walks one prompt older per click, all the way to the oldest.
  // Stepping one at a time (settling between clicks) keeps each smooth scroll short.
  await page.locator(".transcript-wrap").hover();
  const upBtn = page.getByTestId("prompt-nav-up");
  const downBtn = page.getByTestId("prompt-nav-down");
  for (let i = last; i >= 0; i--) {
    await upBtn.click({ force: true });
    await waitForPrompt(page, i);
    await expect.poll(() => atPrompt(page, i)).toBe(true);
  }
  // Past the oldest, ↑ clamps — it stays on the first prompt.
  await upBtn.click({ force: true });
  await waitForPrompt(page, 0);

  // ↓ walks back toward newer prompts…
  for (let i = 1; i <= last; i++) {
    await downBtn.click({ force: true });
    await waitForPrompt(page, i);
    await expect.poll(() => atPrompt(page, i)).toBe(true);
  }
  // …and stepping past the newest returns to the live bottom.
  await downBtn.click({ force: true });
  await expect.poll(atBottom).toBe(true);
});

// Journey: prompt-nav re-anchors to viewport after manual scroll
test("prompt-nav re-anchors to viewport after manual scroll", async ({
  page,
}) => {
  // 380px leaves no hit-testable transcript after the fixed header/composer; 600px
  // keeps the fixture constrained while leaving the scroll region usable.
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.waitForTimeout(50);
  await buildMultiTurn(page, 5);
  await page.locator(".scroller").focus();

  // ↑ from the tail lands on the last prompt.
  await page.getByTestId("prompt-nav-up").press("Enter");
  await expect.poll(() => atPrompt(page, 5)).toBe(true);

  // Set scrollTop directly so userScrolling remains false. This reproduces the
  // intervening viewport shift that previously made the next jump use stale cursor
  // state; the next ↑ must anchor to the current viewport.
  const targetTop = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    const row = document.querySelectorAll(".row.user")[3] as HTMLElement;
    return (
      row.getBoundingClientRect().top -
      sc.getBoundingClientRect().top +
      sc.scrollTop
    );
  });
  await page.evaluate((top) => {
    (document.querySelector(".scroller") as HTMLElement).scrollTop = top;
  }, targetTop);

  // Prompt #3 is at the viewport top, so ↑ should select #2 rather than use a
  // stale cursor position from the previous jump.
  await page.getByTestId("prompt-nav-up").press("Enter");
  await expect.poll(() => atPrompt(page, 2)).toBe(true);

  // From #2 at the top, ↓ selects the first prompt below the viewport fold (#3).
  await page.getByTestId("prompt-nav-down").press("Enter");
  await expect.poll(() => atPrompt(page, 3)).toBe(true);
});

// Journey: ⌘↑/⌘↓ scroll to top/bottom of transcript (not while typing)
test("⌘↑/⌘↓ scroll to top/bottom of transcript (not while typing)", async ({
  page,
}) => {
  await buildMultiTurn(page, 5);
  // Focus the scroller (tabindex=0) without clicking — click may hit a child
  // element (message row, link, code block) and leave focus there instead.
  // Mirrors the scrollUpViaKeyboard helper pattern (helpers.ts:185-191).
  await page.locator(".scroller").focus();
  // ⌘↑ scrolls to the top
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(() =>
    page.evaluate(
      () => (document.querySelector(".scroller") as HTMLElement).scrollTop,
    ),
  ).toBe(0);
  // ⌘↓ scrolls to the bottom
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(() =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      return sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    }),
  ).toBeLessThan(4);
  // While the composer is focused, ⌘↑ does NOT scroll (focus gate).
  // We're at the bottom (scrollTop > 0 for a tall transcript), so if the gate
  // fails, scrollToTop() would change scrollTop to 0 — making the assertion fail.
  await page.locator("textarea").focus();
  const before = await page.evaluate(
    () => (document.querySelector(".scroller") as HTMLElement).scrollTop,
  );
  expect(before).toBeGreaterThan(0); // sanity: we're not already at the top
  await page.keyboard.press("Control+ArrowUp");
  const after = await page.evaluate(
    () => (document.querySelector(".scroller") as HTMLElement).scrollTop,
  );
  expect(after).toBe(before);
});

// Journey: sending a prompt while scrolled up jumps the transcript to the bottom
test("sending a prompt while scrolled up jumps the transcript to the bottom", async ({
  page,
}) => {
  // Build a transcript tall enough that its top and bottom differ.
  await buildMultiTurn(page, 3);

  // Scroll to the top so we're no longer pinned to the bottom — via real wheel
  // input so the input-gated pin registers it as a user action and un-pins.
  const scroller = page.locator(".scroller");
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });
  await wheelUp(page, 2000);
  await expect.poll(gap).toBeGreaterThan(80); // genuinely scrolled up

  // Send a prompt from the composer.
  const box = page.getByPlaceholder("Message pantoken…");
  await box.fill("jump to the bottom please");
  await box.press("Enter");

  // The new turn streams a reply; once it settles we should be pinned at the bottom —
  // the just-sent message + its reply pulled into view, not left below the fold.
  await waitForSettledWorkBlocks(page, 5);
  await expect
    .poll(() =>
      scroller.evaluate((el) => {
        const s = el as HTMLElement;
        return s.scrollHeight - s.scrollTop - s.clientHeight;
      }),
    )
    .toBeLessThan(80);
  // …and the "New messages ↓" catch-up pill never appeared (we followed the stream
  // down instead of falling behind it).
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

// Journey: prev/next prompt-nav buttons are visible on hover and step through prompts
test("prev/next prompt-nav buttons are visible on hover and step through prompts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1100);
  // Build several turns so the oldest prompts have enough content below them to scroll to
  // the top (a short final turn can't, which is fine — the stepper clamps there).
  await buildMultiTurn(page, 5);

  const count = await page.locator(".row.user").count(); // greeting + 5 replies
  expect(count).toBeGreaterThanOrEqual(6);
  const last = count - 1;

  // The nav control is always mounted but hidden (opacity 0) until the transcript is
  // hovered. Hover the transcript-wrap to reveal it.
  const upBtn = page.getByTestId("prompt-nav-up");
  const downBtn = page.getByTestId("prompt-nav-down");
  await page.locator(".transcript-wrap").hover();
  await expect(upBtn).toBeVisible();
  await expect(downBtn).toBeVisible();

  // Buttons have the right tooltips (repo rule: every action names itself).
  await expect(upBtn).toHaveAttribute("title", "Previous prompt");
  await expect(downBtn).toHaveAttribute("title", "Next prompt");

  // From the live tail, clicking ↑ steps one prompt older per click.
  for (let i = last; i >= 0; i--) {
    await upBtn.click({ force: true });
    await waitForPrompt(page, i);
    await expect.poll(() => atPrompt(page, i)).toBe(true);
  }
  // Past the oldest, ↑ clamps.
  await upBtn.click({ force: true });
  await waitForPrompt(page, 0);

  // ↓ walks back toward newer prompts…
  for (let i = 1; i <= last; i++) {
    await downBtn.click({ force: true });
    await waitForPrompt(page, i);
    await expect.poll(() => atPrompt(page, i)).toBe(true);
  }
});

// Journey: switching sessions restores the saved reading position
test("switching sessions restores the saved reading position", async ({
  page,
}) => {
  // Shrink the viewport so the short mock fixtures exceed the fold — only then is
  // "opened at the top" distinguishable from "opened at the bottom". Both the greeting
  // source and the target session scroll at this height.
  await page.setViewportSize({ width: 1100, height: 560 });

  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });

  // Open a different session (taller than the fold) and scroll it PART-way up so it has a
  // saved reading position distinct from the bottom.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // landed at the live bottom (no saved pos)
  await page.waitForTimeout(550); // let the open's settle/save-suppression window lapse
  // Scroll part-way up (not the very top, so the saved ratio is unambiguously mid-transcript)
  // via real wheel input so the input-gated pin un-pins (programmatic scrollTop can't un-pin).
  // Then let the debounced save fire. Target 25% of the scrollable area (not 50%) so the
  // gap stays safely > 80 even if content height changes slightly after setting scrollTop.
  const targetTop = await scroller.evaluate((el) => {
    const s = el as HTMLElement;
    return Math.floor((s.scrollHeight - s.clientHeight) * 0.25);
  });
  await keyboardScrollToPosition(page, targetTop);
  // Assert we're genuinely scrolled up off the bottom (the exact position may
  // differ slightly from targetTop due to browser scroll clamping).
  await expect.poll(gap).toBeGreaterThan(40); // genuinely scrolled up off the bottom
  // Wait for the debounced persist (200ms) to land in localStorage.
  await page.waitForTimeout(350);
  const savedTop = await top();
  const savedHeight = await scroller.evaluate((el) => (el as HTMLElement).scrollHeight);
  const savedRatio = savedTop / savedHeight;

  // Switch to the greeting (a DIFFERENT session), then back. The restored session should
  // land near where we left it, NOT at the live bottom. (We don't assert the greeting's
  // own position — it may restore to ITS saved spot or the bottom; either is fine. We
  // only care that older-session, when we return to it, lands at its saved reading spot.)
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Wire up the WebSocket").click();
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket",
  );
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  // Restored to the saved reading position. The ratio is re-derived against the CURRENT
  // scrollHeight (content-visibility virtualization can render the same turns at different
  // heights between visits), so compare RATIOS rather than pixels: the transcript
  // virtualizes turns to ~500px intrinsic height when off-screen, which swings
  // scrollHeight (and with it any fixed-pixel target) between the save and restore visits
  // even though the saved proportional spot is honored exactly.
  await expect.poll(top).toBeGreaterThan(0); // not at the very top (restored, not blank)
  await page.waitForTimeout(600); // let settleScroll's 500ms chase window finish
  const restoredRatio = await scroller.evaluate((el) => {
    const s = el as HTMLElement;
    return s.scrollHeight > 0 ? s.scrollTop / s.scrollHeight : 0;
  });
  expect(Math.abs(restoredRatio - savedRatio)).toBeLessThan(0.02);
  // …and NOT at the live bottom (gap is meaningfully large, no pill).
  await expect.poll(gap).toBeGreaterThan(40);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

// Journey: a session with no saved position still lands at the live bottom
test("a session with no saved position still lands at the live bottom", async ({
  page,
}) => {
  // Companion to the restore test: a session you've never scrolled (or whose position was
  // cleared) opens at the live tail, not a stale/carried-over spot.
  await page.setViewportSize({ width: 1100, height: 380 });

  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });

  // Wait for the viewport resize (above) to settle: the #64 viewportObserver
  // (ResizeObserver on `.scroller`) re-asserts the bottom when the border-box height
  // changes and the session is pinned.
  await expect.poll(gap).toBeLessThan(80);

  // Switch to a different session that has no saved position — it should open at the
  // live bottom, not a carried-over spot from the greeting. (The greeting at 380px may
  // be too short to scroll; its position is irrelevant — we're asserting older-session
  // opens clean at the bottom.)
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(top).toBeGreaterThan(80);
  await expect.poll(gap).toBeLessThan(80);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

// Journey: switching away does not corrupt the leaving session's saved position
test("switching away does not corrupt the leaving session's saved position", async ({
  page,
}) => {
  // Regression guard for the root save bug: the switch-away save used to run in a
  // post-DOM-patch $effect, by which point the scroller already showed the INCOMING
  // session — so it overwrote the leaving session's ratio with the new session's geometry.
  // Here we record the saved ratio BEFORE the switch and assert it is untouched AFTER.
  await page.setViewportSize({ width: 1100, height: 380 });
  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });
  const savedRatio = (id: string) =>
    page.evaluate((sid) => {
      const raw = localStorage.getItem("pantoken.scrollPositions");
      return raw ? (JSON.parse(raw)[sid]?.ratio ?? null) : null;
    }, id);

  // Open older-session and scroll it to a clear mid-transcript spot; let the debounce land.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // wait for the open to land before scrolling
  await page.waitForTimeout(550); // let the open's settle/save-suppression window lapse
  const targetTop = await scroller.evaluate((el) => {
    const s = el as HTMLElement;
    return Math.floor((s.scrollHeight - s.clientHeight) * 0.25);
  });
  // Via real wheel input so the input-gated pin un-pins (programmatic scrollTop can't).
  await keyboardScrollToPosition(page, targetTop);
  // Assert we're genuinely scrolled up (the exact position may differ slightly
  // from targetTop due to browser scroll clamping).
  await expect.poll(gap).toBeGreaterThan(40);
  await page.waitForTimeout(350); // debounced persist (200ms) + margin
  const before = await savedRatio("older-session");
  expect(before).not.toBeNull();

  // Switch to a DIFFERENT session. The leaving session's saved ratio must be unchanged —
  // the switch must not re-save it against the incoming transcript's geometry.
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Wire up the WebSocket").click();
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket",
  );
  const after = await savedRatio("older-session");
  expect(after).not.toBeNull();
  expect(Math.abs((after as number) - (before as number))).toBeLessThan(0.01);
});

// Journey: a session left at the live tail returns to the tail on focus
test("a session left at the live tail returns to the tail on focus", async ({
  page,
}) => {
  // Factor 3 (owner's call): if you were at the END when you switched away, you come back
  // to the END — not a stale proportional spot. The position is saved with an explicit
  // `atBottom` flag (NOT inferable from the ratio once content grows), and restore chases
  // the live tail for it.
  await page.setViewportSize({ width: 1100, height: 380 });
  const scroller = page.locator(".scroller");
  const top = () => scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  const gap = () =>
    scroller.evaluate((el) => {
      const s = el as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });

  // Open older-session, then deliberately scroll up and back to the bottom so a REAL scroll
  // event (not the open's programmatic snap) persists an at-bottom position.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // wait for the open to land before scrolling
  await page.waitForTimeout(900); // let the open's settle/progScrollUntil window lapse
  // Scroll up via keyboard (Home key) so the input-gated pin un-pins. Keyboard is more
  // reliable than wheel on the small (380px) viewport.
  await scrollUpViaKeyboard(page);
  await expect.poll(gap).toBeGreaterThan(80);
  await page.waitForTimeout(300); // debounced persist of the scrolled-up spot
  // Scroll back to the bottom — reaching the bottom re-pins regardless of input source.
  await scroller.evaluate(
    (el) => ((el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight),
  );
  await expect.poll(gap).toBeLessThan(80);
  await page.waitForTimeout(350); // debounced persist
  const atBottom = await page.evaluate(() => {
    const raw = localStorage.getItem("pantoken.scrollPositions");
    return raw ? JSON.parse(raw)["older-session"]?.atBottom : undefined;
  });
  expect(atBottom).toBe(true);

  // Switch away and back — we should land at the live tail, not the mid-transcript ratio.
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Wire up the WebSocket").click();
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket",
  );
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByText("Explore the fold reducer")
    .click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect.poll(gap).toBeLessThan(80); // back at the live tail
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

// Journey: PWA update prompt appears and can be dismissed
test("PWA update prompt appears and can be dismissed", async ({ page }) => {
  // The ?dev bar's "update" button stands in for a real service-worker update.
  await page.getByRole("button", { name: "update", exact: true }).click();
  const toast = page.getByText("A new version of pantoken is available");
  await expect(toast).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss update" }).click();
  await expect(toast).toBeHidden();
});
