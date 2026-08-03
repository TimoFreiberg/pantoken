import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: the active-only filter hides archived + stale sessions by default,
// with its tooltip carrying the hidden count; toggling reveals everything.
test("active-only filter hides archived + stale sessions; show-all reveals them", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Default is active-only: the archived fixture and the stale (>7d) fixture are hidden.
  await expect(sidebar.getByText("Archived experiment")).toHaveCount(0);
  await expect(sidebar.getByText("Old spike")).toHaveCount(0);
  // The stale session is alone in its project, so the whole group drops out too.
  await expect(sidebar.getByText("stale-proj", { exact: true })).toHaveCount(0);
  // The top-right filter remains the only archived-session affordance. Its tooltip
  // carries the hidden count without spending a standalone line in the sidebar.
  await expect(sidebar.getByTestId("hidden-count")).toHaveCount(0);
  await expect(sidebar.getByTestId("filter-toggle")).toHaveAttribute(
    "title",
    /2 hidden/,
  );

  // Flip to "show all" — everything appears, including its own project group.
  await sidebar.getByTestId("filter-toggle").click();
  await expect(sidebar.getByText("Archived experiment")).toBeVisible();
  await expect(sidebar.getByText("Old spike")).toBeVisible();
  await expect(sidebar.getByText("stale-proj", { exact: true })).toBeVisible();
  await expect(sidebar.getByTestId("hidden-count")).toHaveCount(0);
});

// Journey: active-only/show-all filters preserve hidden-count affordances in one boot.
test("active-only filter and filter affordance expose the same hidden sessions", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Default active-only view hides the archived + stale fixtures, with no extra row.
  await expect(sidebar.getByTestId("hidden-count")).toHaveCount(0);
  await expect(sidebar.getByText("Archived experiment")).toHaveCount(0);
  await expect(sidebar.getByText("Old spike")).toHaveCount(0);
  await expect(sidebar.getByText("stale-proj", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByTestId("filter-toggle")).toHaveAttribute("title", /2 hidden/);

  const filter = sidebar.getByTestId("filter-toggle");
  await expect(filter).toHaveAttribute("aria-label", "Show all sessions");
  await filter.click();
  await expect(sidebar.getByText("Archived experiment")).toBeVisible();
  await expect(sidebar.getByText("Old spike")).toBeVisible();
  await expect(sidebar.getByText("stale-proj", { exact: true })).toBeVisible();
  await expect(sidebar.getByTestId("hidden-count")).toHaveCount(0);
  await expect(filter).toHaveAttribute("aria-label", "Show active sessions only");

  // Restore the default active-only state before ending this journey.
  await filter.click();
  await expect(sidebar.getByText("Archived experiment")).toHaveCount(0);
  await expect(sidebar.getByText("Old spike")).toHaveCount(0);
  await expect(filter).toHaveAttribute("aria-label", "Show all sessions");
});

// Journey: right-clicking a session row opens its overflow menu; archiving
// offers an Undo toast that restores the session, and the menu drives the same
// archive action as the ⋯ trigger.
test("right-click archive offers an Undo toast that restores the session", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();
  await row.locator(".row").click({ button: "right" });
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // The row vanishes from the active view AND a toast offers a one-tap undo.
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Explore the fold reducer" }),
  ).toHaveCount(0);
  const toast = sidebar.getByTestId("toast").filter({ hasText: "Archived" });
  await expect(toast).toBeVisible();

  // Undo restores it (un-archives), and the toast clears.
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(sidebar.getByText("Explore the fold reducer")).toBeVisible();

  // The menu is closed to start with — no hover, no ⋯ click. The menu renders once at
  // the sidebar level (lifted out of the per-row {#each}), so check there for absence.
  await expect(
    sidebar.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toHaveCount(0);

  // Right-click the row itself opens the same menu the ⋯ trigger would.
  await row.locator(".row").click({ button: "right" });
  await expect(
    sidebar.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toBeVisible();

  // And it drives the same action.
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Explore the fold reducer" }),
  ).toHaveCount(0);
});

// Journey: the overflow menu copies the session id to the clipboard.
test("the overflow menu copies the session id to the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // "Explore the fold reducer" is the `older-session` fixture.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByTestId("copy-session-id").click();

  // Clipboard holds the raw session id, and the menu closed itself.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("older-session");
  await expect(sidebar.getByTestId("copy-session-id")).toHaveCount(0);
});

// Journey: pressing 'a' while the menu is open archives the targeted session.
test("pressing 'a' while the menu is open archives the targeted session", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  // Open the floating menu, then drive the archive via its keyboard shortcut.
  await row.hover();
  await row.getByTestId("session-menu").click();
  await expect(
    sidebar.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("a");

  // Archived → gone from the active list, and the menu closed itself.
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Explore the fold reducer" }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toHaveCount(0);
});

// Journey: archiving the focused session drops its row and opens the chooser;
// Undo restores both the session and the transcript view.
test("archiving the focused session drops its row and opens the chooser", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // "Wire up the WebSocket bridge" (demo-session) is the focused session on a fresh
  // server — its transcript is what's showing.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket bridge" });
  await expect(row).toBeVisible();

  // Archive it from its overflow menu.
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // Archiving what you're reading is an explicit "put this away" gesture, so the row
  // drops from the active view and the main pane flips to the chooser (rather than
  // leaving you staring at the archived transcript).
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Wire up the WebSocket bridge" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  // Undo restores both: the session un-archives AND we're put back on its transcript.
  const toast = sidebar.getByTestId("toast").filter({ hasText: "Archived" });
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Wire up the WebSocket bridge" }),
  ).toBeVisible();
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
});

// Journey: the overflow menu archives a session, hiding it from the active
// list; under show-all it's marked archived and Unarchive clears the flag.
test("the overflow menu archives a session, hiding it from the active list", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // "Explore the fold reducer" (older-session) is active + visible by default.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  // Open its overflow menu and archive it.
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // It disappears from the active view (optimistic + server reconcile).
  await expect(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Explore the fold reducer" }),
  ).toHaveCount(0);

  // Under "show all" it's back, marked archived, and the menu now offers Unarchive.
  await sidebar.getByTestId("filter-toggle").click();
  const archivedRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow.getByText("archived")).toBeVisible();

  await archivedRow.hover();
  await archivedRow.getByTestId("session-menu").click();
  await sidebar
    .getByRole("menuitem", { name: "Unarchive", exact: true })
    .click();

  // The archived flag clears (still visible since we're in show-all mode).
  await expect(archivedRow.getByText("archived")).toHaveCount(0);
});
