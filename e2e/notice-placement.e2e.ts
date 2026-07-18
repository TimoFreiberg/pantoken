import { expect, test } from "@playwright/test";
import {
  archiveRow,
  createWorktreeSession,
  drive,
  gotoFresh,
  openSidebar,
} from "./helpers.js";

// Validate that notices render on the correct scoped surface: sidebar-scoped
// notices (archive undo) appear inside the sidebar element as an overlay that
// doesn't displace session rows, while chat-scoped notices (stop errors) appear
// in the chat area and NOT inside the sidebar.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("archive undo notice is an overlay that does not displace session rows", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Capture the "New session" button's position before archiving.
  const newSessionBtn = sidebar.getByTestId("sidebar-new-session");
  await expect(newSessionBtn).toBeVisible();
  const before = await newSessionBtn.boundingBox();
  expect(before).not.toBeNull();

  await archiveRow(page, "Explore the fold reducer");

  // The undo notice appears inside the sidebar element.
  const notice = sidebar.getByTestId("toast").filter({ hasText: "Archived" });
  await expect(notice).toBeVisible();

  // AC.1: the "New session" button did NOT move — the notice is an overlay, not
  // in-flow. (Non-movement is the real acceptance criterion; the CSS position
  // value is an implementation detail, checked supplementally below.)
  const after = await newSessionBtn.boundingBox();
  expect(after).toEqual(before);

  // Supplemental: the notice container is positioned out of flow.
  const containerPos = await sidebar
    .getByTestId("sidebar-notice")
    .evaluate((el) => window.getComputedStyle(el).getPropertyValue("position"));
  expect(containerPos).toBe("absolute");

  // The notice is inside the sidebar-notice container, not the chat-notice container.
  await expect(
    page.getByTestId("sidebar-notice").getByTestId("toast"),
  ).toHaveCount(1);
  await expect(page.getByTestId("chat-notice")).toHaveCount(0);
});

test("a second archive replaces the prior undo notice (only one at a time)", async ({
  page,
}) => {
  await openSidebar(page);

  await archiveRow(page, "Explore the fold reducer");
  await archiveRow(page, "Wire up the WebSocket bridge");

  // AC.2: exactly one archive-Undo toast (the prior was replaced).
  await expect(
    page
      .getByTestId("sidebar-notice")
      .getByTestId("toast")
      .filter({ hasText: "Archived" }),
  ).toHaveCount(1);
});

test("the surviving undo restores the most recently archived session", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Archive two sessions in succession. The second ("Wire up…") is the most recent.
  await archiveRow(page, "Explore the fold reducer");
  await archiveRow(page, "Wire up the WebSocket bridge");

  // The surviving Undo toast reflects the most-recent archive.
  const undo = sidebar
    .getByTestId("toast")
    .filter({ hasText: "Archived" })
    .getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  await undo.click();

  // AC.3: the most-recently-archived session's row reappears (unarchived).
  await expect(
    sidebar.locator(".row-wrap").filter({ hasText: "Wire up the WebSocket bridge" }),
  ).toBeVisible();
});

test("an unrelated worktree-retained notice coexists with a new archive undo", async ({
  page,
}) => {
  // A dirty worktree archive produces BOTH an archive-Undo toast and a
  // "Worktree kept" (Delete anyway) toast.
  await createWorktreeSession(page, "dirty");
  const sidebar = page.getByTestId("sidebar");

  const dirtyRow = sidebar.locator(".row-wrap").filter({ has: page.locator(".wt") });
  await dirtyRow.locator(".row").click({ button: "right" });
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // Both toasts are present.
  await expect(
    sidebar.getByTestId("toast").filter({ hasText: "Archived" }),
  ).toBeVisible();
  await expect(
    sidebar.getByTestId("toast").filter({ hasText: "Worktree kept" }),
  ).toBeVisible();

  // Now archive a clean (fixture) session — its Undo must NOT displace the
  // unrelated "Worktree kept" toast (AC.4: independence — no shared kind).
  await archiveRow(page, "Explore the fold reducer");

  await expect(
    page
      .getByTestId("sidebar-notice")
      .getByTestId("toast")
      .filter({ hasText: "Archived" }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("sidebar-notice")
      .getByTestId("toast")
      .filter({ hasText: "Worktree kept" }),
  ).toHaveCount(1);
});

test("clicking undo dismisses the live delete-anyway toast for that worktree", async ({
  page,
}) => {
  // Archive a dirty-worktree session: produces Undo + "Delete anyway".
  await createWorktreeSession(page, "dirty");
  const sidebar = page.getByTestId("sidebar");

  const dirtyRow = sidebar.locator(".row-wrap").filter({ has: page.locator(".wt") });
  await dirtyRow.locator(".row").click({ button: "right" });
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  const deleteAnyway = sidebar
    .getByTestId("toast")
    .filter({ hasText: "Worktree kept" });
  await expect(deleteAnyway).toBeVisible();

  // AC.5: clicking Undo dismisses the correlated "Delete anyway" toast so it
  // can't force-delete the restored session's worktree.
  const undo = sidebar
    .getByTestId("toast")
    .filter({ hasText: "Archived" })
    .getByRole("button", { name: "Undo" });
  await undo.click();

  await expect(
    page
      .getByTestId("sidebar-notice")
      .getByTestId("toast")
      .filter({ hasText: "Worktree kept" }),
  ).toHaveCount(0);
});

test("stop unconfirmed state appears on the stop button, not as a chat notice or sidebar error", async ({
  page,
}) => {
  // Trigger a stop no-response timeout (the slowabort script delays the
  // entire abort() by 1000ms, so the 500ms timer fires first).
  await drive(page, "slowabort");
  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await stop.click();

  // The stop button shows the retry state.
  await expect(stop).toHaveText("↻ Retry stop", { timeout: 1_500 });

  // No chat notice appears — the unconfirmed state is consolidated to the
  // stop button only.
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast"),
  ).toHaveCount(0);

  // No sidebar error either.
  await expect(page.getByTestId("sidebar").getByTestId("toast")).toHaveCount(0);
});
