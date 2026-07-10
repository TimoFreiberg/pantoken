import { expect, test } from "@playwright/test";
import { gotoFresh, openRightSidebar, openSidebar } from "./helpers.js";

// Runs under the "mobile" project (Pixel 7 viewport).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("opening the drawer does NOT focus the search box on a phone", async ({
  page,
}) => {
  // Focus-on-open is desktop-only: on a phone it would pop the soft keyboard on every
  // open. Opening the drawer (a closed→open transition) must leave the search unfocused.
  await openSidebar(page);
  const search = page
    .getByTestId("sidebar")
    .getByPlaceholder("Search sessions…");
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
});

// Both drawers default CLOSED on a phone (overlay semantics, unchanged); the header
// hamburgers that used to open them are gone, so the header chevron (or the
// left-edge swipe, for the sessions drawer — see edge-swipe.mobile.e2e.ts) is now the
// only tap affordance besides ⌘B / ⌘⇧J (which a soft keyboard doesn't offer anyway).

test("the sessions drawer is closed by default on a phone, with a header arrow to open it", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  const edgeOpen = page.getByTestId("sidebar-open");
  await expect(edgeOpen).toBeVisible();
  await edgeOpen.click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
});

test("the context panel is closed by default on a phone, with a header arrow to open it", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "false");

  const edgeOpen = page.getByTestId("context-open");
  await expect(edgeOpen).toBeVisible();
  await edgeOpen.click();
  await expect(panel).toHaveAttribute("data-open", "true");
  // Sanity: the shared helper works too (same click, wrapped). The collapse
  // control ("Collapse context panel") and the scrim ("Close context panel",
  // tap-outside-to-dismiss) carry distinct labels; scoping kept for locality.
  await panel.getByRole("button", { name: "Collapse context panel" }).click();
  await openRightSidebar(page);
  await expect(panel).toHaveAttribute("data-open", "true");
});
