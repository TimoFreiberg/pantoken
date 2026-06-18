import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

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
  // scope to the session list so we match project-group headers, not the brand wordmark
  const list = sidebar.locator(".list");

  // sessions are grouped under their project dir (basename of cwd)
  await expect(list.getByText("pilot", { exact: true })).toBeVisible();
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

test("rows show a relative last-activity timestamp; the count appears only when collapsed", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Each row carries a relative "time since last activity" label below the name.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await expect(demoRow.locator(".time")).toHaveText(
    /(\d+(m|h|d|w|mo|y) ago|just now)/,
  );

  // The session count is hidden while a group is expanded…
  const pilotGroup = sidebar
    .locator(".group")
    .filter({ has: page.locator(".proj", { hasText: "pilot" }) });
  await expect(pilotGroup.locator(".count")).toHaveCount(0);

  // …and revealed once it's collapsed (the rows themselves disappear).
  await pilotGroup.locator(".group-toggle").click();
  await expect(pilotGroup.locator(".count")).toBeVisible();
  await expect(demoRow).toHaveCount(0);
});

test("relative timestamps tick forward as time passes", async ({ page }) => {
  // Freeze the clock before the app boots so the label is stable, then advance it and
  // assert the minute count climbs — proving the timestamp re-renders, not just stamps once.
  await page.clock.install();
  await gotoFresh(page);
  await openSidebar(page);

  const time = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" })
    .locator(".time");
  const minutes = async (): Promise<number> => {
    const m = (await time.textContent())?.match(/^(\d+)m ago$/);
    if (!m)
      throw new Error(`expected "Nm ago", got "${await time.textContent()}"`);
    return Number(m[1]);
  };

  const before = await minutes();
  await page.clock.runFor(5 * 60_000); // five minutes, firing the 1-minute interval
  await expect(time).toHaveText(`${before + 5}m ago`);
});

test("a project's + button opens a new-session draft for that dir", async ({
  page,
}) => {
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "New session in pilot" })
    .click();
  // Deferred creation: the draft hero shows (nothing is created until you send), and
  // it's prefilled with that group's dir + the default model.
  const hero = page.getByTestId("new-session");
  await expect(hero).toBeVisible();
  await expect(hero).toContainText("/Users/timo/src/pilot");
  await expect(
    page.getByText("Nothing is created until you send"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Claude Opus 4\.8/ }),
  ).toBeVisible();
});

test("a session can be started in an arbitrary typed directory", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  await sidebar.getByText("New session…").click();
  // The project lives as a chip in the composer; click it to edit the path inline.
  await page.locator(".chips .chip").first().click();
  await page
    .getByPlaceholder(/absolute\/path\/to\/project/)
    .fill("/Users/timo/src/elsewhere");
  // Sending the first prompt is what actually creates the session (atomic).
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("kick things off");
  await composer.press("Enter");

  // A new project group appears for the typed dir.
  await openSidebar(page); // (closed by afterNavigate on the mobile drawer)
  await expect(
    page.getByTestId("sidebar").getByText("elsewhere", { exact: true }),
  ).toBeVisible();
});

test("a project group's session list is a plain, un-capped list", async ({
  page,
}) => {
  await openSidebar(page);
  const ul = page.getByTestId("sidebar").locator(".group ul").first();
  await expect(ul).toBeVisible();
  // Plain list: no per-group height cap or inner scroll — the whole sidebar list
  // scrolls instead, and archiving keeps the length manageable.
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

test("clicking the project chip focuses the path input", async ({ page }) => {
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("New session…").click();
  await page.locator(".chips .chip").first().click();
  // Focused via a mount action (the autofocus attr is unreliable here), so you can
  // type a path immediately without a second click.
  await expect(
    page.getByPlaceholder(/absolute\/path\/to\/project/),
  ).toBeFocused();
});

test("the worktree chip creates the session in an isolated worktree dir", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByText("New session…").click();
  // Toggle the worktree chip on first (before editing the path, so the inline path
  // editor's blur doesn't reflow the chip row under the pointer), then set the dir.
  await page.getByRole("button", { name: "worktree" }).click();
  await expect(page.getByRole("button", { name: "worktree" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator(".chips .chip").first().click();
  await page
    .getByPlaceholder(/absolute\/path\/to\/project/)
    .fill("/Users/timo/src/demo");
  // Sending the first prompt creates the session.
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("get started");
  await composer.press("Enter");

  // The mock isolates a worktree request as a sibling "-worktree" dir; the new project
  // group reflects that isolated path rather than the typed one.
  await openSidebar(page);
  await expect(
    page.getByTestId("sidebar").getByText("demo-worktree", { exact: true }),
  ).toBeVisible();
});
