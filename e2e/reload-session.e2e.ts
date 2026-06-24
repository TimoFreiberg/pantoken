import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// The mock has no warm pi session to throw away, so its reloadSession reseeds the same
// transcript openSession would — enough to prove the menu → WS → reseed round-trip. The
// real recovery (dispose + re-warm with fresh config/extensions) lives in the pi driver.
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
