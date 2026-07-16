import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The sidebar re-fetches the session list on open, and while it stays open a
// client-side poll (every 10s) picks up sessions that arrived externally (e.g.
// the daemon created one out-of-band) without any user interaction. The
// `newsession` mock script mutates the mock's `sessions` list WITHOUT emitting
// a SessionDriverEvent, so the server's dirty-flag ticker never fires — the
// client-side poll is the sole delivery path the test exercises.

/** Drive a mock script via the `__pantokenMock` window hook (sends
 *  `{type:"mock", script}` over WS, bypassing the dev-bar scripts array). */
async function mockScript(page: import("@playwright/test").Page, script: string) {
  await page.evaluate((s) => {
    (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
      s,
    );
  }, script);
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a new session appears in the sidebar while it is open (AC.1)", async ({
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
});

test("the poll stops when the sidebar is closed (AC.2)", async ({ page }) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  // the draft row lives in `.draft-top`, outside `.list`, so this naturally
  // excludes it — only persisted session rows are counted.
  const list = sidebar.locator(".list button.row");
  const initialCount = await list.count();

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
  await expect(list).toHaveCount(initialCount);

  // positive control: reopen the sidebar and confirm the new row DOES appear
  // (via the open-on-refresh effect). This proves the `newsession` script
  // actually mutated the mock state — without this, the test above would pass
  // trivially if the script itself were broken.
  await openSidebar(page);
  await expect(sidebar.locator(".list").getByText("External session")).toBeVisible(
    { timeout: 5_000 },
  );
});

test("opening the sidebar still triggers an immediate refresh (AC.3)", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // a session arrives while the sidebar is open; the 10s poll would eventually
  // surface it, but we close before that can happen
  await mockScript(page, "newsession");

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  // reopen — the open-on-refresh $effect should fetch the list immediately,
  // surfacing the new row well within the default 5s timeout (faster than the
  // 10s poll, proving the open-on-refresh effect fired rather than the poll)
  await openSidebar(page);

  await expect(sidebar.locator(".list").getByText("External session")).toBeVisible(
    { timeout: 5_000 },
  );
});
