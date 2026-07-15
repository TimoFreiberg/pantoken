import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// Validate that notices render on the correct scoped surface: sidebar-scoped
// notices (archive undo) appear inside the sidebar element and are in-flow (not
// position:fixed), while chat-scoped notices (stop errors) appear in the chat
// area and NOT inside the sidebar.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("archive undo notice appears inside the sidebar, not as a fixed overlay", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Archive a session via the context menu.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();
  await row.locator(".row").click({ button: "right" });
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // The undo notice appears inside the sidebar element.
  const notice = sidebar.getByTestId("toast").filter({ hasText: "Archived" });
  await expect(notice).toBeVisible();

  // It is in-flow (an ancestor is the sidebar, not a fixed-position overlay).
  // Check that the notice's computed position is not 'fixed'.
  const position = await notice.evaluate((el) =>
    window.getComputedStyle(el).getPropertyValue("position"),
  );
  expect(position).not.toBe("fixed");

  // The notice is inside the sidebar-notice container, not the chat-notice container.
  await expect(
    page.getByTestId("sidebar-notice").getByTestId("toast"),
  ).toHaveCount(1);
  await expect(page.getByTestId("chat-notice")).toHaveCount(0);
});

test("stop error notice appears in the chat area, not in the sidebar", async ({
  page,
}) => {
  // Trigger a stop confirmation timeout (chat-scoped notice).
  await drive(page, "slowabort");
  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await stop.click();

  // The unconfirmed-stop notice appears in the chat-notice container.
  const notice = page
    .getByTestId("chat-notice")
    .getByTestId("toast")
    .filter({ hasText: "Couldn't confirm the stop within 500ms" });
  await expect(notice).toBeVisible();

  // It is in-flow (not position:fixed).
  const position = await notice.evaluate((el) =>
    window.getComputedStyle(el).getPropertyValue("position"),
  );
  expect(position).not.toBe("fixed");

  // The notice is NOT inside the sidebar element.
  await expect(page.getByTestId("sidebar").getByTestId("toast")).toHaveCount(0);
});
