import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("rows are a single line: title plus a compact last-activity timestamp", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });

  // The title and the unified status/time slot share one line. An idle (read) session
  // resolves the slot to a compact timestamp — "5m", "2h", "3d" — no " ago" suffix.
  await expect(
    demoRow.getByTestId("session-status").locator(".time"),
  ).toHaveText(/^\d+(m|h|d|w|mo|y)$/);
});

test("the old second meta line is gone — no msg-count or activity sub-line", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // demo-session used to render "3 msg" and a progress sub-line. The single-line redesign
  // drops both to give the title the full row width.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  await expect(demoRow.locator(".msg-count")).toHaveCount(0);
  await expect(demoRow.locator(".activity")).toHaveCount(0);
});

test("the context ring only appears once a session crosses the fill threshold", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

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
});

test("an unread session marks the left gutter and keeps its timestamp on the right", async ({
  page,
}) => {
  await openSidebar(page);
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
  // …and — unlike the other status states — the right slot keeps the compact timestamp,
  // since the unread cue has moved to the gutter.
  await expect(status.locator(".time")).toHaveText(/^(\d+(m|h|d|w|mo|y)|now)$/);
});
