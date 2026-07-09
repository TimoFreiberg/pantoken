import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// The mock has no warm session to throw away, so its reloadSession reseeds the same
// transcript openSession would — enough to prove the menu → WS → reseed round-trip. The
// real recovery (dispose + re-warm with fresh config/extensions) lives in the polytoken driver.
test("the overflow menu reloads a session, reseeding its transcript", async ({
  page,
}) => {
  // Start on the greeting session.
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket bridge",
  );

  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByTestId("reload-session").click();

  // The reloaded session becomes active and its transcript is (re)seeded.
  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
});

test("the L hotkey reloads the menu's targeted session", async ({ page }) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  // The menu is open and targets this row; pressing L reloads it (no click on the item).
  await page.keyboard.press("l");

  await expect(page.locator("header .title")).toContainText(
    "Explore the fold reducer",
  );
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
});

// Regression for docs/TODO.md: "The feature that collapses the early working part
// of a turn when the final message is written seems to not be triggered when a
// cold session is restored in the GUI." The "Cold-restore regression check"
// fixture's seed (`restored_session_seed` in mock_driver.rs) mirrors what the
// polytoken driver's `history_to_seed_events` + `build_branch_seed` actually
// produce for a genuine cold restore with real tool work: settled via a bare
// idle `SessionUpdated` re-assert, never a `runCompleted` — unlike every other
// mock fixture (`greeting_seed`/`session_seed`), which ends on `runCompleted`
// and so never exercised this exact shape.
test("opening a cold-restored session collapses its settled work behind 'Worked for Ns'", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByText("Cold-restore regression check").click();

  await expect(page.locator("header .title")).toContainText(
    "Cold-restore regression check",
  );
  // No lingering "still working" affordance — the session is genuinely idle.
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
  // The tool work is offered collapsed (not forced inline), and closed by default.
  const toggle = page.getByTestId("work-toggle");
  await expect(toggle).toHaveText(/Worked for/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("work-body")).toHaveCount(0);
  // The turn-final reply stays visible outside the collapsed block.
  await expect(
    page.getByText("now backs off exponentially", { exact: false }),
  ).toBeVisible();
});

test("reloading a cold session re-collapses its settled work (not just first open)", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Cold-restore regression check" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByTestId("reload-session").click();

  await expect(page.locator("header .title")).toContainText(
    "Cold-restore regression check",
  );
  const toggle = page.getByTestId("work-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("work-body")).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
});
