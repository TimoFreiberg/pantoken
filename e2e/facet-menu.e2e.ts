import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Issue #73: the facet menu must not send spurious requests to the daemon.
// Selecting the already-active facet (Enter / click / number-key) is a no-op —
// no setFacet wire message, so no "Facet switched to X" notice and no error.
// The mock driver always succeeds on SetFacet (it never emits the "already
// active" error), so the observable signal is the *absence* of the notice: the
// notice is the side effect of a real request, so its absence proves no request
// was sent. Switching to a *different* facet still sends the request (regression
// guard).
//
// Under create-on-click (phase 3), there is no draft — config is applied as
// live SessionActions after creation. Draft-specific tests have been removed.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("Enter on the active facet sends no request", async ({ page }) => {
  // Default facet is Execute. Open the menu (sel starts on Execute) and press
  // Enter on it — no setFacet request, so no new notice appears.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  // Execute is index 0 — the default highlight.
  await expect(panel.getByRole("option", { name: "Execute" })).toHaveClass(/hl/);
  const before = await page.locator(".row.notice .ntext").count();
  await panel.press("Enter");
  await expect(panel).not.toBeVisible();
  // No new "Facet switched to execute" notice — the request was suppressed.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);
  await expect(badge).toHaveText("Execute");
});

test("clicking the active facet row sends no request", async ({ page }) => {
  // Default facet is Execute. Open the menu and click the Execute row — no
  // setFacet request, so no new notice appears.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  const before = await page.locator(".row.notice .ntext").count();
  await page.getByRole("option", { name: "Execute" }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);
  await expect(badge).toHaveText("Execute");
});

test("number-key on the active facet sends no request", async ({ page }) => {
  // Default facet is Execute (index 0 → number key "1"). Open the menu and
  // press "1" — no setFacet request, so no new notice appears.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  const before = await page.locator(".row.notice .ntext").count();
  await page.keyboard.press("1");
  await expect(panel).not.toBeVisible();
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);
  await expect(badge).toHaveText("Execute");
});

test("selecting a different facet still switches", async ({ page }) => {
  // Regression guard: switching to a *different* facet must still send the
  // setFacet request and produce a new notice.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const before = await page.locator(".row.notice .ntext").count();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toHaveText("Plan");
  // The mock emits a "Facet switched to plan" notice on a real setFacet.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before + 1);
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    /plan/i,
  );
});

// Regression: opening the facet menu via Shift+Tab and closing it, then switching
// sessions (which unmounts + remounts Composer via App.svelte's {#if} block),
// must NOT auto-pop the facet menu. Root cause: MenuBadge's lastOpenN was reset
// to 0 on remount while store.facetMenuOpenN (monotonic, never reset) still
// held a prior value > 0, so the effect re-fired open=true. Fixed by making
// lastOpenN a null sentinel that syncs on the first post-(re)mount observation
// without opening.
test("the facet menu does not auto-open after a Composer remount", async ({
  page,
}) => {
  // Open the facet menu once via Shift+Tab, then close it.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await page.getByPlaceholder("Message pantoken…").focus();
  await page.keyboard.press("Shift+Tab");
  // No rotation — badge stays "Execute".
  await expect(badge).toHaveText("Execute");
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Switch to a different session — this unmounts and remounts Composer,
  // resetting MenuBadge's local state.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .locator(".row", { hasText: "Explore the fold reducer" })
    .click();
  // Composer is remounted against the existing session.
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();

  // The facet menu must NOT have auto-popped on the remount.
  await expect(page.getByRole("listbox", { name: "Facet" })).toHaveCount(0);

  // A fresh Shift+Tab still opens the menu (without rotating). Badge stays the
  // existing session's facet.
  await page.getByPlaceholder("Message pantoken…").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("listbox", { name: "Facet" })).toBeVisible();
});
