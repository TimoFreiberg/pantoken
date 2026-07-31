import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// Desktop sidebar flow tests. One test per coherent user journey, merging the
// former sidebar-toggles, sidebar-row, sidebar-refresh, sidebar-drafts,
// sidebar-resize, and build-pop specs into a single file. Every assertion from
// the source files is preserved here.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// --- sidebar-toggles flows ---

// Journey: both sidebars default open on desktop; collapsing each reveals a
// header panel icon that reopens it in place, the collapse persists across
// reload, and ⌘B / ⌘⇧J still reopen without the header buttons.
test("sidebar toggle: collapse, reopen via header icon, persist across reload, hotkey reopen", async ({
  page,
}) => {
  // Both sidebars are visible by default on desktop.
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  // --- left sidebar collapse/reopen ---
  const sidebar = page.getByTestId("sidebar");
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  const open = page.getByTestId("sidebar-open");

  await expect(open).toHaveCount(0);
  // The panel icon is wrapped in a span (not a direct child of .icon-btn), so it
  // keeps its explicit size and isn't expanded to the button's inherited font-size.
  // AC.1: the left-sidebar collapse button shows a panel-left icon (divider at x=9).
  const collapseIcon = collapse.locator("svg");
  await expect(collapseIcon).toHaveAttribute("width", "15");
  await expect(collapseIcon).toHaveCSS("width", "15px");
  await expect(collapse.locator("line")).toHaveAttribute("x1", "9");
  const collapseBox = await collapse.boundingBox();
  await collapse.click();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("title", /^Show sessions/);
  // AC.2: the "Show sessions" reopen button shows a panel-left icon (divider at x=9).
  await expect(open.locator("line")).toHaveAttribute("x1", "9");

  // The sidebar's collapse toggle sits at its trailing edge, so this one can't share
  // its x — but it shares the top row, which is what makes collapse/expand a click
  // back and forth near the same corner rather than a hunt down the screen edge.
  const openBox = await open.boundingBox();
  expect(collapseBox).not.toBeNull();
  expect(openBox).not.toBeNull();
  expect(Math.abs(openBox!.y - collapseBox!.y)).toBeLessThanOrEqual(1);

  await open.click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  // The toggle itself disappears again once its sidebar is open.
  await expect(open).toHaveCount(0);

  // --- context panel collapse/reopen ---
  const panel = page.getByTestId("right-sidebar");
  const collapseCtx = page.getByRole("button", {
    name: "Collapse context panel",
  });
  const openCtx = page.getByTestId("context-open");

  await expect(openCtx).toHaveCount(0);
  // AC.3 (desktop): the right-sidebar collapse button shows a panel-right icon
  // (divider at x=15).
  await expect(collapseCtx.locator("line")).toHaveAttribute("x1", "15");
  const collapseCtxBox = await collapseCtx.boundingBox();
  await collapseCtx.click();
  await expect(panel).toHaveAttribute("data-open", "false");

  await expect(openCtx).toBeVisible();
  await expect(openCtx).toHaveAttribute(
    "data-tip-title",
    /^Show context panel/,
  );
  // AC.5 (desktop): the entry shows even at context count 0 (no badge).
  await expect(openCtx.getByTestId("context-badge")).toHaveCount(0);
  // AC.4 (desktop): the context-open reopen button shows a panel-right icon (x=15).
  await expect(openCtx.locator(".chevron-desktop line")).toHaveAttribute(
    "x1",
    "15",
  );
  // AC.6: the desktop icon wrapper is not mirrored (no scaleX(-1) transform).
  await expect(openCtx.locator(".chevron-desktop")).not.toHaveCSS(
    "transform",
    /matrix/,
  );

  // Same pixel as the collapse control it replaced — so collapse/expand/collapse
  // is a repeatable click on one spot, not a hunt for a mid-edge tab.
  const openCtxBox = await openCtx.boundingBox();
  expect(collapseCtxBox).not.toBeNull();
  expect(openCtxBox).not.toBeNull();
  expect(Math.abs(openCtxBox!.x - collapseCtxBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(openCtxBox!.y - collapseCtxBox!.y)).toBeLessThanOrEqual(1);

  await openCtx.click();
  await expect(panel).toHaveAttribute("data-open", "true");
  await expect(openCtx).toHaveCount(0);

  // --- collapse persists across reload ---
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );

  await gotoFresh(page);

  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  // Restore it so this test doesn't leak a closed default into anything reading
  // localStorage after it (each test gets its own context, but be tidy regardless).
  await page.getByTestId("sidebar-open").click();

  // --- ⌘B and ⌘⇧J reopen a collapsed sidebar without the header buttons ---
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Collapse context panel" }).click();
  await expect(sidebar).toHaveAttribute("data-open", "false");
  await expect(panel).toHaveAttribute("data-open", "false");

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "true");

  await page.keyboard.press("Control+Shift+j");
  await expect(panel).toHaveAttribute("data-open", "true");
});

// --- sidebar-row flows ---

// Journey: the sidebar row redesign dropped the old meta sub-lines, the context
// ring appears only past a fill threshold, and an unread session marks the left
// gutter while keeping its timestamp on the right.
test("sidebar row: no meta sub-line, context ring threshold, unread gutter mark", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // The old second meta line is gone — no msg-count or activity sub-line.
  // demo-session used to render "3 msg" and a progress sub-line. The single-line redesign
  // drops both to give the title the full row width.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await expect(demoRow.locator(".msg-count")).toHaveCount(0);
  await expect(demoRow.locator(".activity")).toHaveCount(0);

  // The context ring only appears once a session crosses the fill threshold.
  // demo-session sits at 24% (MOCK_USAGE) — below the threshold, so its row stays clean.
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Wire up the WebSocket" })
      .locator(".meter"),
  ).toHaveCount(0);

  // older-session is at 82% (MOCK_USAGE_HIGH) — over the threshold, so it lights up the
  // gauge in its accent (hot) band as a quiet "getting full" cue.
  const olderRing = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" })
    .locator(".meter");
  await expect(olderRing).toBeVisible();
  await expect(olderRing).toHaveClass(/\baccent\b/);

  // An unread session marks the left gutter and keeps its timestamp on the right.
  const row = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  const status = row.getByTestId("session-status");

  // Drive a background turn to completion, then reset the mock: the server clears the
  // "done" attention phase while the client keeps the session flagged unread — landing in
  // the plain unread state.
  await drive(page, "bgrun");
  await expect(status).toHaveAttribute("data-state", "done");
  await page.request.get("/debug/reset");
  await expect(status).toHaveAttribute("data-state", "unread");

  // Unread shows as a dot in the LEFT gutter (not the right slot)…
  await expect(row.locator(".lead .unread-dot")).toBeVisible();
  // …and — unlike the other status states — the row keeps the compact timestamp (now in
  // .row-time, hover-revealed on desktop), since the unread cue has moved to the gutter.
  await row.hover();
  await expect(row.locator(".row-time")).toHaveText(
    /^(\d+(m|h|d|w|mo|y)|now)$/,
  );
});

// --- sidebar-refresh flows ---

/** Drive a mock script via the `__pantokenMock` window hook (sends
 *  `{type:"mock", script}` over WS, bypassing the dev-bar scripts array). */
async function mockScript(
  page: import("@playwright/test").Page,
  script: string,
) {
  await page.evaluate((s) => {
    (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
      s,
    );
  }, script);
}

// Journey: the sidebar re-fetches the session list on open, a client-side poll
// (every 10s) picks up sessions that arrived externally while it is open, the
// poll stops when the sidebar closes, and reopening triggers an immediate
// refresh.
test("sidebar refresh: new session appears via poll while open, poll stops on close, open triggers immediate refresh", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const list = sidebar.locator(".list");

  // baseline: the externally-arriving session is not yet present
  await expect(list.getByText("External session")).toHaveCount(0);

  // a session arrives out-of-band (no event emitted — only the client-side
  // poll calling listSessions will surface it)
  await mockScript(page, "newsession");

  // the poll fires every 10s; give it 15s of margin. Playwright polls
  // internally and returns as soon as the row appears.
  await expect(list.getByText("External session")).toBeVisible({
    timeout: 15_000,
  });

  // The poll stops when the sidebar is closed (AC.2).
  // the draft row lives in `.draft-top`, outside `.list`, so this naturally
  // excludes it — only persisted session rows are counted.
  const rowCount = sidebar.locator(".list button.row");
  const initialCount = await rowCount.count();

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await mockScript(page, "newsession");

  // wait longer than the 10s poll interval — if the interval leaked, a poll
  // would have fired and fetched the new row by now
  await page.waitForTimeout(12_000);

  // the count must NOT have increased: the interval was cleared on close and
  // no poll fired. (Using row count rather than toBeVisible because the
  // desktop sidebar uses display:none when closed, which would make a
  // visibility check pass trivially regardless of whether the poll ran.)
  await expect(rowCount).toHaveCount(initialCount);

  // positive control: reopen the sidebar and confirm the new row DOES appear
  // (via the open-on-refresh effect). This proves the `newsession` script
  // actually mutated the mock state — without this, the test above would pass
  // trivially if the script itself were broken.
  await openSidebar(page);
  await expect(
    sidebar.locator(".list").getByText("External session"),
  ).toBeVisible({ timeout: 5_000 });

  // Opening the sidebar still triggers an immediate refresh (AC.3).
  // a session arrives while the sidebar is open; the 10s poll would eventually
  // surface it, but we close before that can happen
  await mockScript(page, "newsession");

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  // reopen — the open-on-refresh $effect should fetch the list immediately,
  // surfacing the new row well within the default 5s timeout (faster than the
  // 10s poll, proving the open-on-refresh effect fired rather than the poll)
  await openSidebar(page);

  await expect(
    sidebar.locator(".list").getByText("External session"),
  ).toBeVisible({ timeout: 5_000 });
});

// --- sidebar-drafts flows ---

/** The project group `<section>` whose header names `proj` (cwd basename). */
function group(page: Page, proj: string) {
  return page
    .getByTestId("sidebar")
    .locator("section.group")
    .filter({ has: page.locator(".proj", { hasText: proj }) });
}

function sessionRow(page: Page, title: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: title });
}

/** Create a new session in the named project via its group "+" button. */
async function newSessionIn(page: Page, proj: string) {
  await page.getByRole("button", { name: `New session in ${proj}` }).click();
}

// Journey: creating a session via the project group "+" nests it under its
// project, highlights only the new session, the row survives navigating away,
// and collapsing the group hides its session rows.
test("sidebar session creation: nests under project, highlight moves, survives navigate-away, group collapse hides row", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // A created session nests under its project and survives navigating away.
  const beforeCount = await sidebar.locator(".row").count();
  await newSessionIn(page, "pantoken");

  // The new session row appears under the pantoken group.
  await expect(sidebar.locator(".row")).toHaveCount(beforeCount + 1);

  // The new session is the active row.
  await expect(sidebar.locator(".row.active")).toHaveCount(1);

  // Send a prompt so the session is non-empty — phase 2 reaps empty sessions
  // on navigate-away (without a prompt the row would vanish).
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("keep me alive");
  await composer.press("Enter");

  // Navigate to an existing session — the new session row stays (idle).
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(sidebar.locator(".row")).toHaveCount(beforeCount + 1);

  // Creating a session highlights only the new session — the previously focused
  // session drops its highlight.
  // The greeting session is focused (and highlighted) before any creation.
  const focusedRow = sidebar.locator("button.row", {
    hasText: "Wire up the WebSocket bridge",
  });
  // Navigate back to the greeting first so it's active again.
  await focusedRow.click();
  await expect(focusedRow).toHaveClass(/\bactive\b/);

  await newSessionIn(page, "pantoken");

  // The new session is the only highlighted row in the sidebar.
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);
  await expect(focusedRow).not.toHaveClass(/\bactive\b/);

  // Navigate to the existing session — its highlight is restored, new session drops it.
  await focusedRow.click();
  await expect(focusedRow).toHaveClass(/\bactive\b/);
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);

  // A session row hides when its project group is collapsed.
  await newSessionIn(page, "pantoken");

  const pantoken = group(page, "pantoken");
  // The newly created session row is visible under pantoken.
  const newRow = pantoken.locator(".row").last();
  await expect(newRow).toBeVisible();

  // Collapsing the group hides the session row with it.
  await pantoken.locator(".group-toggle").click();
  await expect(newRow).toBeHidden();
});

// --- sidebar-resize flows ---

const LEFT_KEY: string = "pantoken.sidebarWidth";
const RIGHT_KEY: string = "pantoken.rightSidebarWidth";

async function clearWidths(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(({ left, right }) => {
    if (sessionStorage.getItem("pantoken.sidebarWidthsCleared") === "1") return;
    localStorage.removeItem(left);
    localStorage.removeItem(right);
    sessionStorage.setItem("pantoken.sidebarWidthsCleared", "1");
  }, { left: LEFT_KEY, right: RIGHT_KEY });
}

async function width(
  page: import("@playwright/test").Page,
  testid: string,
): Promise<number> {
  return page
    .getByTestId(testid)
    .evaluate((el) => el.getBoundingClientRect().width);
}

// Journey: dragging the sessions sidebar handle and the context panel handle
// changes each width independently, and both chosen widths survive reload.
test("sidebar resize: drag handles change widths independently and survive reload", async ({
  page,
}) => {
  await clearWidths(page);
  await gotoFresh(page);

  const sidebar = page.getByTestId("sidebar");

  // dragging the sessions sidebar handle changes its width
  const handle = page.getByRole("separator", { name: "Resize sessions sidebar" });
  const before = await width(page, "sidebar");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + 200);
  await page.mouse.up();
  await expect.poll(() => width(page, "sidebar")).toBeGreaterThan(before + 50);
  await expect(sidebar).toHaveAttribute("data-open", "true");
  expect(await width(page, "right-sidebar")).toBeGreaterThan(0);

  // dragging the context panel changes only the right width
  const leftBefore = await width(page, "sidebar");
  const rightBefore = await width(page, "right-sidebar");
  const handle2 = page.getByRole("separator", { name: "Resize context panel" });
  const box2 = await handle2.boundingBox();
  expect(box2).not.toBeNull();
  await page.mouse.move(box2!.x + box2!.width / 2, box2!.y + 200);
  await page.mouse.down();
  await page.mouse.move(box2!.x + box2!.width / 2 - 80, box2!.y + 200);
  await page.mouse.up();
  await expect
    .poll(() => width(page, "right-sidebar"))
    .toBeGreaterThan(rightBefore + 50);
  expect(await width(page, "sidebar")).toBeCloseTo(leftBefore, 0);

  // both chosen widths survive reload
  const left = page.getByRole("separator", { name: "Resize sessions sidebar" });
  const leftBox = await left.boundingBox();
  expect(leftBox).not.toBeNull();
  await page.mouse.move(leftBox!.x + 6, leftBox!.y + 200);
  await page.mouse.down();
  await page.mouse.move(leftBox!.x + 56, leftBox!.y + 200);
  await page.mouse.up();

  const right = page.getByRole("separator", { name: "Resize context panel" });
  const rightBox = await right.boundingBox();
  expect(rightBox).not.toBeNull();
  await page.mouse.move(rightBox!.x + 6, rightBox!.y + 200);
  await page.mouse.down();
  await page.mouse.move(rightBox!.x - 44, rightBox!.y + 200);
  await page.mouse.up();

  const chosen = {
    left: await width(page, "sidebar"),
    right: await width(page, "right-sidebar"),
  };
  const stored = await page.evaluate(({ leftKey, rightKey }) => ({
    left: Number(localStorage.getItem(leftKey)),
    right: Number(localStorage.getItem(rightKey)),
  }), { leftKey: LEFT_KEY, rightKey: RIGHT_KEY });
  expect(stored.left).toBeCloseTo(chosen.left, 0);
  expect(stored.right).toBeCloseTo(chosen.right, 0);
  await page.reload();
  // At this viewport the larger combined preferences make auto hide Context.
  // Widening must restore both raw choices without having overwritten them.
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  await page.setViewportSize({ width: 1500, height: 850 });
  await expect
    .poll(() => width(page, "sidebar"))
    .toBeCloseTo(chosen.left, 0);
  await expect
    .poll(() => width(page, "right-sidebar"))
    .toBeCloseTo(chosen.right, 0);
});

// Journey: resize handles expose accessibility metadata and keyboard controls,
// and pointer cancellation / window blur releases the resize interaction.
test("sidebar resize: a11y metadata, keyboard controls, pointer cancellation and blur release", async ({
  page,
}) => {
  await clearWidths(page);
  await gotoFresh(page);

  // resize handles expose accessibility metadata and keyboard controls
  for (const name of ["Resize sessions sidebar", "Resize context panel"]) {
    const handle = page.getByRole("separator", { name });
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("title", new RegExp(name));
    await expect(handle).toHaveAttribute("aria-valuemin", "200");
    await expect(handle).toHaveAttribute("aria-valuemax", /[0-9]+/);
    await expect(handle).toHaveAttribute("aria-valuenow", /[0-9]+/);
  }
  const handle = page.getByRole("separator", { name: "Resize sessions sidebar" });
  const before = await width(page, "sidebar");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => width(page, "sidebar")).toBeGreaterThan(before + 10);
  await page.keyboard.press("Home");
  await expect.poll(() => width(page, "sidebar")).toBeCloseTo(200, 0);

  const right = page.getByRole("separator", { name: "Resize context panel" });
  const rightBefore = await width(page, "right-sidebar");
  await right.focus();
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => width(page, "right-sidebar"))
    .toBeGreaterThan(rightBefore + 10);
  await page.keyboard.press("Home");
  await expect
    .poll(() => width(page, "right-sidebar"))
    .toBeCloseTo(200, 0);
  await page.keyboard.press("End");
  await expect
    .poll(() => width(page, "right-sidebar"))
    .toBeLessThanOrEqual(540);

  // pointer cancellation and window blur release the resize interaction
  const handle2 = page.getByRole("separator", {
    name: "Resize sessions sidebar",
  });
  const box = await handle2.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 6, box!.y + 200);
  await page.mouse.down();
  await page.evaluate(() => {
    document
      .querySelector('[role="separator"]')
      ?.dispatchEvent(
        new PointerEvent("pointercancel", { bubbles: true }),
      );
  });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        cursor: document.documentElement.style.cursor,
        select: document.documentElement.style.userSelect,
      })),
    )
    .toEqual({ cursor: "", select: "" });

  await page.mouse.move(box!.x + 6, box!.y + 200);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        cursor: document.documentElement.style.cursor,
        select: document.documentElement.style.userSelect,
      })),
    )
    .toEqual({ cursor: "", select: "" });
});

// --- build-pop flows ---

// Journey: hovering the version stamp shows a structured pop-up with the commit
// hash + date, clicking the hash line copies it to the clipboard, and scrolling
// the sidebar dismisses the pop-up.
test("build-stamp pop-up: hover shows commit hash, click copies to clipboard, scroll dismisses", async ({
  page,
  context,
}) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  const pop = page.getByTestId("build-pop");

  // hovering the version stamp shows a pop-up with the commit hash
  await expect(pop).toBeHidden(); // not shown until hovered

  await version.hover();
  await expect(pop).toBeVisible();
  // The hash line is present inside the pop-up.
  await expect(page.getByTestId("copy-build-hash")).toBeVisible();
  const hashText = await page.getByTestId("copy-build-hash").textContent();
  expect(hashText).toMatch(/([0-9a-f]{7,}|dev)/);

  // Mouseleave dismisses it.
  await page.mouse.move(0, 0);
  await expect(pop).toBeHidden();

  // clicking the hash line copies the commit hash to the clipboard
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await version.hover();
  await expect(page.getByTestId("build-pop")).toBeVisible();

  // Read the hash text from the .hash-text span (not the whole button, which
  // also contains the copy icon character).
  const hash =
    (await page.locator(".hash-text").textContent())?.trim() ?? "";

  await page.getByTestId("copy-build-hash").click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(hash);

  // pop-up dismisses on sidebar scroll
  // Re-hover to show the pop-up again (the click may have dismissed it).
  await version.hover();
  await expect(pop).toBeVisible();

  // A fixed-position pop-up detaches from its anchor on scroll. The listener
  // is on capture-phase window scroll, scoped to .sidebar. Dispatch a scroll
  // event on the sidebar's list element (the real scroll source).
  await page.getByTestId("sidebar").evaluate((el) => {
    const list = el.querySelector(".list");
    if (list) {
      list.scrollTop = 10;
      list.dispatchEvent(new Event("scroll", { bubbles: false }));
    }
  });
  await expect(pop).toBeHidden();
});
