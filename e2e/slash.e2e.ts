import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openRightSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const ta = (page: Page) => page.locator(".composer-wrap textarea");
const row = (page: Page, name: string) =>
  page.getByTestId("slash-menu").locator(`[data-cmd="${name}"]`);
const mcpMenu = (page: Page) => page.getByTestId("mcp-arg-menu");
const mcpServerRow = (page: Page, name: string) =>
  mcpMenu(page).locator(`[data-server="${name}"]`);
const mcpActionRow = (page: Page, name: string) =>
  mcpMenu(page).locator(`[data-action="${name}"]`);
const argMenu = (page: Page) => page.getByTestId("arg-menu");
const argRow = (page: Page, name: string) =>
  argMenu(page).locator(`[data-name="${name}"]`);

// Journey: open the slash menu, filter commands, accept via Enter, and dismiss via Escape.
test("slash menu: open, filter, accept, and dismiss", async ({ page }) => {
  const box = ta(page);
  // A leading slash opens the command menu with all three command sources.
  await box.fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(row(page, "review")).toBeVisible();
  await expect(row(page, "plan")).toBeVisible();
  await expect(row(page, "skill:debug")).toBeVisible();

  // Typing filters the menu to matching commands.
  await box.fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(row(page, "review")).toBeVisible();
  // "plan" doesn't contain "re", so it's filtered out.
  await expect(row(page, "plan")).toHaveCount(0);

  // Enter accepts the highlighted command into the draft.
  // Use "/rev" (not "/re") so only "review" matches — builtins like
  // "reset-shell" also prefix-match "/re" and sort before "review".
  await box.fill("/rev");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await box.press("Enter");
  // The bare token is replaced with `/name ` (trailing space) and the menu closes —
  // no message is sent, so the user can add arguments.
  await expect(box).toHaveValue("/review ");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);

  // Escape dismisses the menu without changing the draft.
  await box.fill("/re");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await box.press("Escape");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await expect(box).toHaveValue("/re");
});

// Journey: filtered commands (interactive-only, no UI) do not appear in the slash menu.
test("slash menu: filtered commands do not appear", async ({ page }) => {
  const box = ta(page);
  await box.fill("/jo");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // /jobs is filtered (interactive, no UI), so it should not appear.
  await expect(row(page, "jobs")).toHaveCount(0);
});

// Journey: new client-implemented builtins are discoverable in the slash menu.
test("slash menu: new builtins appear", async ({ page }) => {
  const box = ta(page);
  await box.fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // Implemented builtins should be discoverable.
  await expect(row(page, "reset-shell")).toBeVisible();
  await expect(row(page, "daemon-reload")).toBeVisible();
  await expect(row(page, "goal")).toBeVisible();
  await expect(row(page, "title")).toBeVisible();
  await expect(row(page, "facet")).toBeVisible();
  // /mcp is now client-implemented (no longer omitted).
  await expect(row(page, "mcp")).toBeVisible();
});

// /clear is intercepted and clears context instead of sending text.
// Journey: /clear intercepts the command and clears context.
test("slash menu: /clear intercepts and clears context", async ({ page }) => {
  // Drive to contextfull so the drop to 0% is unambiguous (mirrors
  // context-meter.e2e.ts).
  await drive(page, "contextfull");
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /91% used/,
  );

  const box = ta(page);
  await box.fill("/clear");
  await box.press("Enter");

  // Composer is cleared.
  await expect(box).toHaveValue("");
  // No user message with "/clear" is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/clear).)*$/s,
  );
  // Context meter drops to 0% (mock emits UsageUpdated for ClearContext).
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /0% used/,
  );
});

// /compact is intercepted and triggers compaction instead of sending text.
// Journey: /compact intercepts the command and triggers compaction.
test("slash menu: /compact intercepts and triggers compaction", async ({ page }) => {
  await drive(page, "contextfull");
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /91% used/,
  );

  const box = ta(page);
  await box.fill("/compact");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/compact).)*$/s,
  );
  // Mock emits UsageUpdated { percent: 4 } for Compact.
  await expect(page.getByTestId("context-trigger")).toHaveAttribute(
    "aria-label",
    /4% used/,
  );
});

// Submit path: unknown commands show an inline error, known commands pass through as text.
// Journey: submit path — unknown commands error, known commands pass through.
test("slash menu: submit path — unknown error and known passthrough", async ({ page }) => {
  const box = ta(page);
  // An unknown slash command shows an inline error and is not sent.
  await box.fill("/nonexistent");
  await box.press("Enter");

  // Inline error appears.
  await expect(page.getByTestId("attachment-status")).toContainText(
    "Unknown slash command: /nonexistent",
  );
  // Composer is NOT cleared — the text stays.
  await expect(box).toHaveValue("/nonexistent");
  // No user message is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/nonexistent).)*$/s,
  );

  // A known command passes through as text.
  // Type with a trailing space so the slash typeahead menu doesn't open
  // (slashQuery returns null once whitespace appears). This tests the
  // submit() passthrough path directly — the menu-accept path is covered
  // by the "open, filter, accept" flow.
  await box.fill("/review ");
  await box.press("Enter");

  // The mock sends it as a normal prompt — the latest user message is "/review".
  await expect(page.locator(".row.user .btext").last()).toContainText("/review");
});

// /reset-shell is intercepted and shows a notification.
// Journey: /reset-shell intercepts and shows a notification.
test("slash menu: /reset-shell intercepts and shows notification", async ({ page }) => {
  const box = ta(page);
  await box.fill("/reset-shell");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/reset-shell).)*$/s,
  );
  // Mock emits HostUiRequest::Notify "Shell environment restored".
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Shell environment restored",
  );
});

// /facet submit path: switch facet via full command, then usage error with no args.
// Journey: /facet submit path — switching facets and the no-args error.
test("slash menu: /facet submit path — switch and no-args error", async ({ page }) => {
  const box = ta(page);
  // /facet <name> is intercepted and switches facet.
  await box.fill("/facet plan");
  await box.press("Enter");

  // Composer is cleared.
  await expect(box).toHaveValue("");
  // No user message with "/facet" is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/facet).)*$/s,
  );
  // Facet badge updates to "Plan".
  await expect(page.getByTestId("facet-badge")).toContainText("Plan");
  // Info notice appears in the transcript.
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Facet switched to plan",
  );

  // /facet with no args shows usage error.
  await box.fill("/facet ");
  // The facet arg menu is open — dismiss it so Enter submits the draft
  // (instead of accepting a facet). This exercises the submit-path guard.
  await box.press("Escape");
  await expect(page.getByTestId("arg-menu")).toHaveCount(0);
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Usage: /facet <name>",
  );
  await expect(box).toHaveValue("/facet ");
});

// /facet arg-menu: open, select via typeahead, navigate with arrow keys, dismiss via Escape.
// Journey: /facet arg-menu — open, select, navigate, and dismiss.
test("slash menu: /facet arg-menu — open, select, navigate, dismiss", async ({ page }) => {
  const box = ta(page);
  // Typing /facet<space> opens the facet arg menu with all mock facets.
  await box.fill("/facet ");
  await expect(argMenu(page)).toBeVisible();
  // The mock fixture provides execute, plan, research.
  await expect(argRow(page, "execute")).toBeVisible();
  await expect(argRow(page, "plan")).toBeVisible();
  await expect(argRow(page, "research")).toBeVisible();

  // Selecting a facet from the menu dispatches and clears the composer.
  await box.fill("/facet pl");
  await expect(argRow(page, "plan")).toBeVisible();
  await box.press("Enter");
  // Composer is cleared (immediate dispatch, no two-Enter).
  await expect(box).toHaveValue("");
  // Facet badge updates to "Plan".
  await expect(page.getByTestId("facet-badge")).toContainText("Plan");

  // Arrow keys navigate the facet arg menu and Enter selects the highlighted item.
  await box.fill("/facet ");
  await expect(argMenu(page)).toBeVisible();
  // Default highlight is on the first item (execute). ArrowDown moves to plan.
  await box.press("ArrowDown");
  await box.press("Enter");
  // Composer is cleared.
  await expect(box).toHaveValue("");
  // Facet badge reads "Plan" (not "Execute" — the first/default item).
  await expect(page.getByTestId("facet-badge")).toContainText("Plan");

  // Escape dismisses the facet arg menu without dispatching.
  await box.fill("/facet ");
  await expect(argMenu(page)).toBeVisible();
  await box.press("Escape");
  // Menu closed, composer still holds the text, no facet change.
  await expect(argMenu(page)).toHaveCount(0);
  await expect(box).toHaveValue("/facet ");
});

// /goal lifecycle: set, pause, resume, clear, then no-args usage error.
// Journey: /goal lifecycle — set, pause, resume, clear, and the no-args error.
test("slash menu: /goal lifecycle — set, pause, resume, clear, no-args error", async ({ page }) => {
  const box = ta(page);
  // /goal set <text> is intercepted and shows the goal badge.
  await box.fill("/goal set ship the feature");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/goal).)*$/s,
  );
  // Goal badge appears with the summary.
  await expect(page.getByTestId("goal-badge")).toBeVisible();
  await expect(page.getByTestId("goal-badge")).toContainText("ship the feature");
  // Info notice appears in the transcript.
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Goal set: ship the feature",
  );

  // /goal pause is intercepted and shows paused state.
  // Set a goal first.
  await expect(page.getByTestId("goal-badge")).toBeVisible();
  await box.fill("/goal pause");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Goal badge shows paused class.
  await expect(page.getByTestId("goal-badge")).toHaveClass(/paused/);
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Goal paused",
  );

  // /goal resume is intercepted and returns to active state.
  // Set + pause first.
  await expect(page.getByTestId("goal-badge")).toHaveClass(/paused/);
  await box.fill("/goal resume");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Goal badge no longer has paused class.
  await expect(page.getByTestId("goal-badge")).not.toHaveClass(/paused/);
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Goal resumed",
  );

  // /goal clear is intercepted and removes the goal badge.
  // Set a goal first.
  await expect(page.getByTestId("goal-badge")).toBeVisible();
  await box.fill("/goal clear");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Goal badge disappears.
  await expect(page.getByTestId("goal-badge")).toHaveCount(0);
  // Info notice appears in the transcript (last notice = most recent action).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Goal cleared",
  );

  // /goal with no args shows usage info.
  await box.fill("/goal ");
  // The goal subcommand menu is open — dismiss it so Enter submits the draft
  // (instead of accepting a subcommand). This exercises the submit-path guard.
  await box.press("Escape");
  await expect(page.getByTestId("arg-menu")).toHaveCount(0);
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Use /goal set <text>, /goal pause, /goal resume, or /goal clear",
  );
});

// /title: set a custom title, then clear the override with no args.
// Journey: /title — set and clear the override.
test("slash menu: /title — set and clear override", async ({ page }) => {
  const box = ta(page);
  // /title <text> is intercepted and updates the session title.
  await box.fill("/title my custom title");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/title).)*$/s,
  );
  // Status header title updates.
  await expect(page.locator(".title-row .title")).toContainText(
    "my custom title",
  );
  // /title does NOT produce a transcript notice (it doesn't affect
  // session contents).
  await expect(page.locator(".row.notice")).toHaveCount(0);

  // /title with no args clears the title override.
  // Set a custom title first.
  await expect(page.locator(".title-row .title")).toContainText(
    "my custom title",
  );

  // /title with no args clears the override → reverts to the inferred title.
  await box.fill("/title ");
  await box.press("Enter");

  await expect(box).toHaveValue("");
  // Title reverts to the mock's default (no longer "my custom title").
  await expect(page.locator(".title-row .title")).not.toContainText(
    "my custom title",
  );
});

// /mcp server menu: discover /mcp, open server arg menu, filter, select server, see actions.
// Journey: /mcp server menu — discover, filter, select, and see actions.
test("slash menu: /mcp server menu — discover, filter, select, see actions", async ({ page }) => {
  const box = ta(page);
  // /mcp appears in the slash menu and is not filtered.
  await box.fill("/m");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(row(page, "mcp")).toBeVisible();

  // Typing /mcp<space> opens the server arg menu with both mock servers.
  await box.fill("/mcp ");
  await expect(mcpMenu(page)).toBeVisible();
  // The mock fixture has 2 servers: filesystem + github.
  await expect(mcpServerRow(page, "filesystem")).toBeVisible();
  await expect(mcpServerRow(page, "github")).toBeVisible();

  // The server arg menu filters by substring.
  await box.fill("/mcp file");
  await expect(mcpMenu(page)).toBeVisible();
  await expect(mcpServerRow(page, "filesystem")).toBeVisible();
  await expect(mcpServerRow(page, "github")).toHaveCount(0);

  // Selecting a server advances to the action menu listing all four actions.
  await expect(mcpServerRow(page, "filesystem")).toBeVisible();
  await box.press("Enter");
  // Draft now holds the server name + trailing space, action menu opens.
  await expect(box).toHaveValue("/mcp filesystem ");
  await expect(mcpMenu(page)).toBeVisible();
  await expect(mcpActionRow(page, "enable")).toBeVisible();
  await expect(mcpActionRow(page, "disable")).toBeVisible();
  await expect(mcpActionRow(page, "disconnect")).toBeVisible();
  await expect(mcpActionRow(page, "reconnect")).toBeVisible();
});

// /mcp dispatch: disable a server, then error cases (no args, unknown action).
// Journey: /mcp dispatch and error handling.
test("slash menu: /mcp dispatch and error handling", async ({ page }) => {
  const box = ta(page);
  // Open the right sidebar so the MCP section is visible (it's the test oracle).
  await openRightSidebar(page);
  // filesystem starts connected.
  await expect(
    page.getByTestId("mcp-servers").locator(".mcp-item").first().locator(".mcp-dot"),
  ).toHaveClass(/mcp-connected/);

  // Selecting disable dispatches, clears the composer, and flips the sidebar status.
  await box.fill("/mcp filesystem ");
  await expect(mcpActionRow(page, "disable")).toBeVisible();
  await box.press("Enter");

  // Composer is cleared (immediate dispatch, no two-Enter).
  await expect(box).toHaveValue("");
  // No user message with "/mcp" is sent.
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/mcp).)*$/s,
  );
  // The mock maps disable → Disconnected; the sidebar dot flips.
  await expect(
    page.getByTestId("mcp-servers").locator(".mcp-item").first().locator(".mcp-dot"),
  ).toHaveClass(/mcp-disconnected/);

  // /mcp with no args shows a usage error and does not send.
  await box.fill("/mcp ");
  // The server arg menu is open — dismiss it so Enter submits the draft
  // (instead of accepting a server). This exercises the submit-path guard.
  await box.press("Escape");
  await expect(page.getByTestId("mcp-arg-menu")).toHaveCount(0);
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Usage: /mcp <server> <action>",
  );
  await expect(box).toHaveValue("/mcp ");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/mcp).)*$/s,
  );

  // /mcp with an unknown action shows an error and does not send.
  await box.fill("/mcp filesystem bogus");
  await box.press("Enter");

  await expect(page.getByTestId("attachment-status")).toContainText(
    "Unknown /mcp action: bogus",
  );
  await expect(box).toHaveValue("/mcp filesystem bogus");
  await expect(page.locator(".row.user .btext")).toHaveText(
    /^((?!\/mcp).)*$/s,
  );
});

// /goal arg-menu: open subcommand menu, select set, dispatch clear, Tab to pause.
// Journey: /goal arg-menu — open, select set, dispatch clear, and Tab to pause.
test("slash menu: /goal arg-menu — open, select set, dispatch clear, Tab to pause", async ({ page }) => {
  const box = ta(page);
  // Typing /goal<space> opens the subcommand menu with set/clear/pause/resume.
  await box.fill("/goal ");
  await expect(argMenu(page)).toBeVisible();
  await expect(argRow(page, "set")).toBeVisible();
  await expect(argRow(page, "clear")).toBeVisible();
  await expect(argRow(page, "pause")).toBeVisible();
  await expect(argRow(page, "resume")).toBeVisible();

  // Selecting set from the menu inserts /goal set and shows the hint.
  await box.fill("/goal se");
  await expect(argRow(page, "set")).toBeVisible();
  await box.press("Enter");

  // Composer holds "/goal set " (no dispatch), hint is visible, menu closed.
  await expect(box).toHaveValue("/goal set ");
  await expect(page.getByTestId("goal-set-hint")).toBeVisible();
  await expect(argMenu(page)).toHaveCount(0);

  // Selecting clear from the menu dispatches immediately.
  // Set a goal first so clearing has an observable effect.
  await box.fill("/goal set ship the feature");
  await box.press("Enter");
  await expect(page.getByTestId("goal-badge")).toBeVisible();

  await box.fill("/goal cl");
  await expect(argRow(page, "clear")).toBeVisible();
  await box.press("Enter");

  // Composer is cleared, goal badge is gone.
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("goal-badge")).toHaveCount(0);

  // Tab selects the highlighted item in the goal subcommand menu.
  // Set a goal first so pausing has an observable effect.
  await box.fill("/goal set ship the feature");
  await box.press("Enter");
  await expect(page.getByTestId("goal-badge")).toBeVisible();

  await box.fill("/goal ");
  await expect(argMenu(page)).toBeVisible();
  // ArrowDown to the second item (pause), then Tab to accept.
  await box.press("ArrowDown");
  await box.press("Tab");

  await expect(box).toHaveValue("");
  await expect(page.getByTestId("goal-badge")).toHaveClass(/paused/);
});
