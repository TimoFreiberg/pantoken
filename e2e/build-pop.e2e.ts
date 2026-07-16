import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The build-stamp hover pop-up (sidebar footer): hovering the version label
// shows a structured card with the commit hash + date. The hash line is
// click-to-copy. A desktop affordance (hover), so this spec runs in the
// desktop project. The mobile tap-to-pin path is in build-pop.mobile.e2e.ts.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("hovering the version stamp shows a pop-up with the commit hash", async ({
  page,
}) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  const pop = page.getByTestId("build-pop");
  await expect(pop).toBeHidden(); // not shown until hovered

  await version.hover();
  await expect(pop).toBeVisible();
  // The hash line is present inside the pop-up.
  await expect(page.getByTestId("copy-build-hash")).toBeVisible();
  const hashText = await page.getByTestId("copy-build-hash").textContent();
  expect(hashText).toMatch(/([0-9a-f]{7,}|dev)/);

  // Mouseleave dismisses it.
  await page.mouse.move(0, 0);
  await expect(pop).toBeHidden();
});

test("pop-up stays open when pointer moves onto it", async ({ page }) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  const pop = page.getByTestId("build-pop");

  await version.hover();
  await expect(pop).toBeVisible();

  // Move the pointer onto the pop-up card itself — the transparent bridge
  // keeps the hover region continuous so mouseleave never fires.
  await pop.hover();
  await expect(pop).toBeVisible();
});

test("pop-up text is selectable", async ({ page }) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  await version.hover();
  const pop = page.getByTestId("build-pop");
  await expect(pop).toBeVisible();

  // Computed user-select on a .build-line should be "text".
  const selectable = await page.evaluate(() => {
    const el = document.querySelector(".build-line");
    if (!el) return null;
    return getComputedStyle(el).userSelect;
  });
  expect(selectable).toBe("text");
});

test("copy icon appears on hash line hover", async ({ page }) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  await version.hover();
  await expect(page.getByTestId("build-pop")).toBeVisible();

  const hashLine = page.getByTestId("copy-build-hash");
  await hashLine.hover();
  // Wait for the opacity transition (0.1s) to complete.
  await page.waitForTimeout(200);

  // The .copy-icon should become visible (opacity > 0) on hash line hover.
  const opacity = await page.evaluate(() => {
    const el = document.querySelector(".copy-icon");
    if (!el) return null;
    return parseFloat(getComputedStyle(el).opacity);
  });
  expect(opacity).not.toBeNull();
  expect(opacity!).toBeGreaterThan(0);
});

test("clicking the hash line copies the commit hash to the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  await version.hover();
  await expect(page.getByTestId("build-pop")).toBeVisible();

  // Read the hash text from the .hash-text span (not the whole button, which
  // also contains the copy icon character).
  const hash = (await page.locator(".hash-text").textContent())?.trim() ?? "";

  await page.getByTestId("copy-build-hash").click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(hash);
});

test("build-menu and force-update testids are absent", async ({ page }) => {
  await openSidebar(page);
  // The old right-click menu and force-update action are removed entirely.
  await expect(page.getByTestId("build-menu")).toHaveCount(0);
  await expect(page.getByTestId("force-update")).toHaveCount(0);
});

test("pop-up dismisses on sidebar scroll", async ({ page }) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  const pop = page.getByTestId("build-pop");

  await version.hover();
  await expect(pop).toBeVisible();

  // A fixed-position pop-up detaches from its anchor on scroll. The listener
  // is on capture-phase window scroll, scoped to .sidebar. Dispatch a scroll
  // event on the sidebar's list element (the real scroll source).
  await page.getByTestId("sidebar").evaluate((el) => {
    const list = el.querySelector(".list");
    if (list) {
      list.scrollTop = 10;
      list.dispatchEvent(new Event("scroll", { bubbles: false }));
    }
  });
  await expect(pop).toBeHidden();
});
