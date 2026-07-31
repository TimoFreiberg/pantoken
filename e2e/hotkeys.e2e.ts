import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// CI runs Chromium on Linux, where the app's hotkeys read Ctrl (the handler accepts
// metaKey || ctrlKey), so the presses use "Control+…" to match the other specs.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const chooser = (page: Page) => page.getByTestId("session-chooser");
const title = (page: Page) => page.locator("header .title");
function row(page: Page, name: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: name });
}

// ⌘N opens the session chooser and pre-selects the last-active project
test("⌘N opens the session chooser", async ({ page }) => {
  // Boot lands on the bridge session (project "pantoken"); no chooser yet.
  await expect(chooser(page)).toHaveCount(0);

  await page.keyboard.press("Control+n");

  await expect(chooser(page)).toBeVisible();
  // The chooser pre-selects the last-active project (pantoken).
  await expect(
    chooser(page).getByTestId("chooser-project-pantoken"),
  ).toHaveAttribute("aria-current", "true");
});

// ⌘[ and ⌘] step back and forward through visited sessions
test("⌘[ and ⌘] step back and forward through visited sessions", async ({
  page,
}) => {
  await openSidebar(page);
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Visit a second session.
  await row(page, "Explore the fold reducer").click();
  await expect(title(page)).toContainText("Explore the fold reducer");

  // Back → the bridge session.
  await page.keyboard.press("Control+[");
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Forward → the fold-reducer session again.
  await page.keyboard.press("Control+]");
  await expect(title(page)).toContainText("Explore the fold reducer");
});

// Back history reaches the chooser from a visited session
test("back history reaches the chooser", async ({ page }) => {
  await openSidebar(page);
  // session → chooser, then back lands on the session again.
  await page.keyboard.press("Control+n");
  await expect(chooser(page)).toBeVisible();

  await page.keyboard.press("Control+[");
  await expect(chooser(page)).toHaveCount(0);
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  await page.keyboard.press("Control+]");
  await expect(chooser(page)).toBeVisible();
});

// Ctrl+Tab / Ctrl+Shift+Tab cycle through sessions in sidebar order
test("Ctrl+Tab / Ctrl+Shift+Tab cycle through sessions in sidebar order", async ({
  page,
}) => {
  // Boot lands on the active row. Sidebar order: project groups A→Z (pantoken,
  // retry-lib, scratch), newest-first within a group — so "Wire up…" → "Explore…" →
  // the cold-restore regression fixture (mock_driver.rs's own distinct-cwd group,
  // added for the cold-restore collapse bug, docs/TODO.md) → the scratch session.
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Explore the fold reducer");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Cold-restore regression check");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("scratch");

  // Past the last row wraps back to the top.
  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Shift reverses, and wraps off the top to the last row.
  await page.keyboard.press("Control+Shift+Tab");
  await expect(title(page)).toContainText("scratch");

  await page.keyboard.press("Control+Shift+Tab");
  await expect(title(page)).toContainText("Cold-restore regression check");
});

// ⌘B toggles the sidebar, ⌘K focuses search, ⌘⇧J toggles the context panel
test("⌘B, ⌘K, and ⌘⇧J toggle sidebar, search, and context panel", async ({
  page,
}) => {
  // --- ⌘B toggles the sidebar ---
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "true"); // desktop default

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "true");

  // --- ⌘K focuses the sidebar session search ---
  // The sidebar is open by default on desktop. ⌘K should open the search
  // overlay and focus the input.
  await page.keyboard.press("Control+k");

  const input = page.getByTestId("sidebar-search-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();

  // Close the search overlay before testing the context panel hotkey.
  await page.keyboard.press("Escape");

  // --- ⌘⇧J toggles the context panel ---
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "true"); // desktop default

  await page.keyboard.press("Control+Shift+j");
  await expect(panel).toHaveAttribute("data-open", "false");

  await page.keyboard.press("Control+Shift+j");
  await expect(panel).toHaveAttribute("data-open", "true");
});
