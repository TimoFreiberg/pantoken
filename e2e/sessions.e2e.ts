import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the sidebar groups sessions by project and switches the active one", async ({
  page,
}) => {
  // the header shows the active (greeting) session's title
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket bridge",
  );

  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  // scope to the session list so we match project-group headers, not the
  // "pantoken" that also shows up as the header subtitle / composer placeholder
  const list = sidebar.locator(".list");

  // sessions are grouped under their project dir (basename of cwd)
  await expect(list.getByText("pantoken", { exact: true })).toBeVisible();
  await expect(list.getByText("scratch", { exact: true })).toBeVisible();

  // the other mock sessions are listed (one named, one preview-only)
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();
  await expect(sidebar.getByText("quick scratch session")).toBeVisible();

  // switching swaps the transcript to the chosen session's history
  await sidebar.getByText("Explore the fold reducer").click();
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
  // and the previous session's content is gone
  await expect(page.getByText("Add a /health route to the server")).toHaveCount(
    0,
  );
  // the header now reflects the switched-to session
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
});

test("the header subtitle shows the active session's project (cwd basename)", async ({
  page,
}) => {
  const subtitle = page.locator("header .sub .path");
  // The greeting session lives in /Users/timo/src/pantoken → project "pantoken",
  // proving the subtitle reads the cwd rather than the old hardcoded "pantoken".
  await expect(subtitle).toHaveText("pantoken");

  // Switching to a session in a different project updates the subtitle.
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("quick scratch session").click();
  await expect(subtitle).toHaveText("scratch");
});

test("an empty launch restores this client's last-focused session", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByText("Explore the fold reducer").click();
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) =>
            key.startsWith("pantoken.lastSession.") &&
            value === "older-session",
        ),
      ),
    )
    .toBe(true);

  // Leave the server on the same empty landing as the real driver after a restart,
  // while retaining its stable identity + on-disk session list.
  await page.request.get("/debug/reset?bootstrap=0");
  await page.reload();

  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
});

test("a stale last-focused session falls back to the chooser", async ({
  page,
}) => {
  const key = await page.evaluate(() => {
    const found = Object.keys(localStorage).find((k) =>
      k.startsWith("pantoken.lastSession."),
    );
    if (!found) throw new Error("last-session preference was not persisted");
    localStorage.setItem(found, "missing-session");
    return found;
  });

  await page.request.get("/debug/reset?bootstrap=0");
  await page.reload();

  // With no restorable session, the chooser appears (phase 3 boot-with-no-restore).
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
});

test("rows show a relative last-activity timestamp; the count appears only when collapsed", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Each row carries a compact "time since last activity" label at the end of its line.
  // The timestamp is hover-revealed on desktop (hidden by default), so hover first.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await demoRow.hover();
  await expect(demoRow.locator(".row-time")).toHaveText(
    /^(\d+(m|h|d|w|mo|y)|now)$/,
  );

  // The session count is hidden while a group is expanded…
  const pantokenGroup = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
  await expect(pantokenGroup.locator(".count")).toHaveCount(0);

  // …and revealed once it's collapsed (the rows themselves disappear).
  await pantokenGroup.locator(".group-toggle").click();
  await expect(pantokenGroup.locator(".count")).toBeVisible();
  await expect(demoRow).toHaveCount(0);
});

test("a collapsed project stays collapsed after a reload; other projects aren't affected", async ({
  page,
}) => {
  // docs/TODO.md: "The collapsed state of projects in the sidebar should be
  // persisted, so when restoring the GUI, it should keep projects collapsed that I
  // previously collapsed."
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const pantokenGroup = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
  const retryLibGroup = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "retry-lib" }) });

  // Collapse pantoken only — retry-lib stays expanded.
  await pantokenGroup.locator(".group-toggle").click();
  await expect(pantokenGroup.locator(".count")).toBeVisible();
  await expect(retryLibGroup.locator(".count")).toHaveCount(0);

  // Reload: this is a client-only localStorage preference, independent of the
  // server's (freshly re-fetched) session list, so it must survive a full reboot.
  await page.reload();
  await openSidebar(page);
  await expect(pantokenGroup.locator(".count")).toBeVisible();
  await expect(
    pantokenGroup.getByText("Wire up the WebSocket bridge"),
  ).toHaveCount(0);
  // The untouched project wasn't collapsed by the reload — keyed per-project, not global.
  await expect(retryLibGroup.locator(".count")).toHaveCount(0);
  await expect(
    retryLibGroup.getByText("Cold-restore regression check"),
  ).toBeVisible();

  // Expanding it back removes the count and reveals the rows again — round-trip intact.
  await pantokenGroup.locator(".group-toggle").click();
  await expect(pantokenGroup.locator(".count")).toHaveCount(0);
  await expect(
    pantokenGroup.getByText("Wire up the WebSocket bridge"),
  ).toBeVisible();
});

test("relative timestamps tick forward as time passes", async ({ page }) => {
  // Freeze the clock before the app boots so the label is stable, then advance it and
  // assert the minute count climbs — proving the timestamp re-renders, not just stamps once.
  await page.clock.install();
  await gotoFresh(page);
  await openSidebar(page);

  const demoRow = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  const time = demoRow.locator(".row-time");
  const minutes = async (): Promise<number> => {
    const m = (await time.textContent())?.match(/^(\d+)m$/);
    if (!m) throw new Error(`expected "Nm", got "${await time.textContent()}"`);
    return Number(m[1]);
  };

  const before = await minutes();
  await page.clock.runFor(5 * 60_000); // five minutes, firing the 1-minute interval
  // The timestamp is hover-revealed on desktop; hover so toHaveText's visibility wait
  // passes (textContent() above works on opacity-hidden elements, but toHaveText
  // auto-waits for visibility and would time out on opacity: 0).
  await demoRow.hover();
  await expect(time).toHaveText(`${before + 5}m`);
});

test("a project's + button creates a session immediately in that dir", async ({
  page,
}) => {
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();

  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "New session in pantoken" })
    .click();

  // Create-on-click: the session is created immediately — no chooser, no draft.
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  // A new session row appears.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});

test("a session can be started in a directory chosen via the chooser's Browse", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const beforeCount = await sidebar.locator(".row").count();

  // Open the chooser, then use Browse… to pick a directory via the DirPicker.
  await sidebar.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await page.getByTestId("chooser-browse").click();
  const picker = page.getByTestId("dir-picker");
  await expect(picker).toBeVisible();
  const input = picker.getByLabel("Project directory path");
  await input.fill("/Users/timo/src/elsewhere/");
  await expect(picker.getByTestId("use-current-directory")).toBeVisible();
  await picker.getByTestId("use-current-directory").click();
  await expect(picker).toBeHidden();

  // A session is created immediately in the chosen dir.
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);

  // A new project group appears for the chosen dir.
  await openSidebar(page); // (closed by afterNavigate on the mobile drawer)
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
  await expect(
    page.getByTestId("sidebar").getByText("elsewhere", { exact: true }),
  ).toBeVisible();
});

test("a project group's session list has no per-group CSS height cap", async ({
  page,
}) => {
  await openSidebar(page);
  const ul = page.getByTestId("sidebar").locator(".group ul").first();
  await expect(ul).toBeVisible();
  // No per-group height cap or inner scroll — the whole sidebar list scrolls
  // instead, and archiving keeps the length manageable. (The rendered row count
  // is capped at 5 per group with a "Show more" button — that's a row-count
  // limit, not a CSS height limit, so it doesn't affect this assertion.)
  const styles = await ul.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { overflowY: cs.overflowY, maxHeight: cs.maxHeight };
  });
  expect(styles.overflowY).toBe("visible");
  expect(styles.maxHeight).toBe("none");
});

test("the session search filters by name, preview, and path", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByTestId("sidebar-search-toggle").click();
  const search = sidebar.getByPlaceholder("Search sessions…");

  // name match: "fold" → only "Explore the fold reducer"
  await search.fill("fold");
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toHaveCount(
    0,
  );
  await expect(sidebar.getByText("quick scratch session")).toHaveCount(0);

  // path match: "scratch" → the session whose cwd ends in /scratch
  await search.fill("scratch");
  await expect(sidebar.getByText("quick scratch session")).toBeVisible();
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);

  // clearing restores every session
  await search.fill("");
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();
  await expect(sidebar.getByText("quick scratch session")).toBeVisible();
});

test("search Enter opens the top match; Esc clears the query", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByTestId("sidebar-search-toggle").click();
  const search = sidebar.getByPlaceholder("Search sessions…");

  // Filter to a single match, then Enter opens it (becomes the active row). Assert the
  // single-match premise explicitly so a future fixture that adds another "fold" session
  // doesn't silently weaken this into "Enter opens *some* row".
  await search.fill("fold");
  await expect(sidebar.locator(".row-wrap")).toHaveCount(1);
  await search.press("Enter");
  await expect(sidebar.locator(".row.active")).toContainText(
    "Explore the fold reducer",
  );

  // Esc on a non-empty query clears it (and restores the full list) rather than closing.
  await search.fill("fold");
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toHaveCount(
    0,
  );
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toBeVisible();
});

test("reopening the sidebar starts compact; search focuses only after activation (desktop)", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // ⌘B round-trips the store toggle. Drawer reopen must not focus a hidden input.
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "false");
  await page.keyboard.press("Control+b");
  await expect(sidebar.getByTestId("sidebar-search-input")).toHaveCount(0);

  // Explicit desktop activation mounts and focuses Search.
  await sidebar.getByTestId("sidebar-search-toggle").click();
  await expect(sidebar.getByTestId("sidebar-search-input")).toBeFocused();
});

test("a project with >5 sessions shows a 'Show more' button that reveals the rest", async ({
  page,
}) => {
  await gotoFresh(page);
  // Clear any expanded-groups state a prior test may have left in localStorage —
  // gotoFresh's addInitScript only clears scrollPositions, not this key (the
  // persistence test below deliberately leaves it set and verifies it survives
  // a reload, so it can't be cleared globally).
  await page.evaluate(() =>
    localStorage.removeItem("pantoken.sidebarExpandedGroups"),
  );
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const list = sidebar.locator(".list");

  // Inject 6 extra sessions into the pantoken project via the mock dev-bar script.
  await drive(page, "manysessions");
  // The Mock handler doesn't broadcast the session list — close + reopen the
  // sidebar to trigger store.refreshSessions() (the sidebar-open $effect).
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await openSidebar(page);

  const pantokenGroup = list
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });

  // Only 5 session rows visible initially (2 existing + 6 injected = 8; cap hides 3).
  // Use [data-testid="session-status"] (on every session row button) to count rows
  // precisely — avoids matching draft rows or the show-more button.
  await expect(pantokenGroup.locator("[data-testid='session-status']")).toHaveCount(5);

  // The "Show more" button appears and reports the hidden count (3).
  const showMore = pantokenGroup.getByTestId("show-more-sessions");
  await expect(showMore).toBeVisible();
  await expect(showMore).toContainText("Show 3 more");

  // Per the issue: plain text, no border or background.
  await expect(showMore).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(showMore).toHaveCSS("border-top-style", "none");

  // Clicking reveals all sessions.
  await showMore.click();
  await expect(pantokenGroup.locator("[data-testid='session-status']")).toHaveCount(8);
  // "Show less" button appears.
  await expect(pantokenGroup.getByTestId("show-less-sessions")).toBeVisible();

  // Clicking "Show less" re-caps to 5.
  await pantokenGroup.getByTestId("show-less-sessions").click();
  await expect(pantokenGroup.locator("[data-testid='session-status']")).toHaveCount(5);
});

test("expanded 'Show more' state persists across a reload", async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
  await drive(page, "manysessions");
  // Refresh: close + reopen to pick up the injected sessions.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const pantokenGroup = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
  await pantokenGroup.getByTestId("show-more-sessions").click();
  await expect(pantokenGroup.locator("[data-testid='session-status']")).toHaveCount(8);

  await page.reload();
  await openSidebar(page);
  // Still expanded after reload.
  const reloadedGroup = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
  await expect(reloadedGroup.getByTestId("show-less-sessions")).toBeVisible();
  await expect(reloadedGroup.locator("[data-testid='session-status']")).toHaveCount(8);
});
