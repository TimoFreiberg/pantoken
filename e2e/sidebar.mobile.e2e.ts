import { expect, test } from "@playwright/test";
import {
  closeOverlayAndWaitForOwnedPop,
  drive,
  gotoFresh,
  openRightSidebar,
  openSidebar,
} from "./helpers.js";

// Mobile sidebar flow tests (Pixel 7 viewport). One test per coherent user
// journey, merging the former sidebar.mobile, sidebar-resize.mobile, and
// build-pop.mobile specs into a single file. Every assertion from the source
// files is preserved here.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// --- mobile sidebar drawer + rows ---

// Journey: on a phone both drawers default closed, the sessions drawer opens
// via a header panel icon, opening it does NOT focus the search box (no soft
// keyboard pop), and the last-activity timestamp stays always-visible beside
// the ⋯ button at full opacity (no hover on touch).
test("mobile sessions drawer: closed by default, header icon opens it, search not auto-focused, timestamp always visible", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");

  // Both drawers default CLOSED on a phone (overlay semantics, unchanged); the
  // header panel icon is the only tap affordance besides ⌘B / ⌘⇧J.
  await expect(sidebar).toHaveAttribute("data-open", "false");

  const edgeOpen = page.getByTestId("sidebar-open");
  await expect(edgeOpen).toBeVisible();
  await edgeOpen.click();
  await expect(sidebar).toHaveAttribute("data-open", "true");

  // Opening the drawer does NOT focus the search box on a phone — focus-on-open
  // is desktop-only; on a phone it would pop the soft keyboard on every open.
  await expect(sidebar.getByTestId("sidebar-search-toggle")).toBeVisible();
  await expect(sidebar.getByTestId("sidebar-search-input")).toHaveCount(0);
  await sidebar.getByTestId("sidebar-search-toggle").click();
  const search = sidebar.getByTestId("sidebar-search-input");
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();

  // The last-activity timestamp is always visible beside the ⋯ on a phone
  // (no hover). AC.3 — On mobile (≤859px) the timestamp stays always-visible
  // beside the always-visible ⋯ button. No hover available on touch, so the
  // desktop hover-reveal must be reset to opacity:1 here.
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  const time = demoRow.locator(".row-time");
  // Visible without hovering, and at full opacity (not the desktop default of 0).
  await expect(time).toBeVisible();
  await expect(time).toHaveCSS("opacity", "1");
  await expect(time).toHaveText(/^\d+(m|h|d|w|mo|y)$/);
});

// --- mobile context panel + badge ---

// Journey: the context panel is closed by default on a phone and reachable from
// the header; its collapse button shows a panel-right icon that is not mirrored;
// and when context items exist the header entry shows a count badge.
test("mobile context panel: closed by default, reachable from header, collapse icon not mirrored, shows badge with context", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "false");

  // The header context entry is always visible (no badge at count 0).
  const open = page.getByTestId("context-open");
  await expect(open).toBeVisible();
  await open.click();
  await expect(panel).toHaveAttribute("data-open", "true");
  // AC.3 (mobile): the right-sidebar collapse button shows a panel-right icon (x=15).
  const collapse = panel.getByRole("button", { name: "Collapse context panel" });
  await expect(collapse.locator("line")).toHaveAttribute("x1", "15");
  // AC.7: the mobile collapse glyph is not mirrored (no scaleX(-1) transform).
  await expect(collapse.locator(".collapse-glyph")).not.toHaveCSS(
    "transform",
    /matrix/,
  );
  // The collapse control ("Collapse context panel") and the scrim
  // ("Close context panel", tap-outside-to-dismiss) carry distinct labels;
  // scoping keeps the control lookup local to the drawer.
  await closeOverlayAndWaitForOwnedPop(page, {
    overlayId: "context",
    close: () => collapse.click(),
    closed: () => expect(panel).toHaveAttribute("data-open", "false"),
  });
  await page.getByTestId("context-open").click();
  await expect(panel).toHaveAttribute("data-open", "true");

  // Now drive to a state with context items and check the header entry badge.
  // Close the panel first so context-open is visible (it hides when panel is open).
  await collapse.click();
  await expect(panel).toHaveAttribute("data-open", "false");

  // The context fixture: 3 flagged files + 3 jobs + 3 todos = 9 context items.
  await drive(page, "context");
  await expect(open).toBeVisible();
  // AC.4 (mobile): the ctx-glyph shows a panel-right icon (x=15) + a visible badge.
  await expect(open.locator(".ctx-glyph line")).toHaveAttribute("x1", "15");
  const badge = open.getByTestId("context-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("9");
});

// --- mobile sidebar resize ---

// Journey: mobile views ignore persisted desktop sidebar widths, have no resize
// handles, and render as full-screen phone views.
test("mobile sidebar resize: ignores desktop widths, no resize handle, full-screen views", async ({
  page,
}) => {
  // This flow needs custom localStorage widths set before boot — do the init
  // script + a fresh load inside the test body (the file-level beforeEach already
  // loaded the page once; this is a second reset+reload, noted in the report).
  await page.addInitScript(() => {
    localStorage.setItem("pantoken.sidebarWidth", "600");
    localStorage.setItem("pantoken.rightSidebarWidth", "500");
  });
  await gotoFresh(page);

  await openSidebar(page);
  await openRightSidebar(page);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toHaveCSS("width", /px$/);
  await expect(page.getByTestId("right-sidebar")).toHaveCSS("width", /px$/);
  // Sessions and Context are full-screen phone views; persisted desktop widths do
  // not affect either surface.
  expect(
    Math.round(
      await page
        .getByTestId("sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    ),
  ).toBe(page.viewportSize()!.width);
  // The context panel is a FULL-SCREEN view on phone (docs/PLAN-mobile.md D2) —
  // the persisted 500px desktop width must not leak into it either way.
  // Rounded: device-pixel scaling makes getBoundingClientRect subpixel (411.9999…).
  expect(
    Math.round(
      await page
        .getByTestId("right-sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    ),
  ).toBe(page.viewportSize()!.width);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        left: localStorage.getItem("pantoken.sidebarWidth"),
        right: localStorage.getItem("pantoken.rightSidebarWidth"),
      })),
    )
    .toEqual({ left: "600", right: "500" });
});

// --- mobile build-stamp tap-to-pin ---

// Journey: on touch devices there's no hover, so tapping the version label pins
// the build-stamp pop-up open (tapping again closes it), and the label meets
// the 44px minimum touch target.
test("mobile build-stamp: tap pins pop-up open, tap again closes, 44px touch target", async ({
  page,
}) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  const pop = page.getByTestId("build-pop");

  // Tapping the version label opens the pop-up.
  await expect(pop).toBeHidden();
  await version.tap();
  await expect(pop).toBeVisible();

  // Tapping again closes it (toggle pin).
  await version.tap();
  await expect(pop).toBeHidden();

  // Version label meets 44px touch target.
  const label = page
    .getByTestId("sidebar")
    .getByTestId("version")
    .locator(".version-label");
  const box = await label.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
