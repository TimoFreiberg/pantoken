import { expect, test } from "@playwright/test";
import { gotoFresh, openRightSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the right sidebar shows an MCP servers section with both mock servers", async ({
  page,
}) => {
  await openRightSidebar(page);
  const section = page.getByTestId("mcp-servers");
  await expect(section).toBeVisible();

  // The mock fixture has 2 servers: filesystem (connected) + github (disconnected).
  await expect(section).toContainText("filesystem");
  await expect(section).toContainText("github");

  // Status dots reflect the mock's initial state.
  const fsRow = section.locator(".mcp-item").filter({ hasText: "filesystem" });
  const ghRow = section.locator(".mcp-item").filter({ hasText: "github" });
  await expect(fsRow.locator(".mcp-dot")).toHaveClass(/mcp-connected/);
  await expect(ghRow.locator(".mcp-dot")).toHaveClass(/mcp-disconnected/);

  // filesystem has 11 tools; github has 0.
  await expect(fsRow).toContainText("11 tools");
});

test("a /mcp round-trip updates the right-sidebar status dot", async ({ page }) => {
  await openRightSidebar(page);
  const section = page.getByTestId("mcp-servers");
  const ghRow = section.locator(".mcp-item").filter({ hasText: "github" });
  // github starts disconnected.
  await expect(ghRow.locator(".mcp-dot")).toHaveClass(/mcp-disconnected/);

  // Dispatch via the composer /mcp command.
  const box = page.locator(".composer-wrap textarea");
  await box.fill("/mcp github enable");
  await box.press("Enter");

  // The mock maps enable → Connected; the sidebar dot flips.
  await expect(ghRow.locator(".mcp-dot")).toHaveClass(/mcp-connected/);
});

test("the MCP settings tab shows configured servers", async ({ page }) => {
  // Open settings (⌘,).
  await page.keyboard.press("Meta+Comma");
  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeVisible();

  // Navigate to the MCP tab.
  await page.getByTestId("settings-tab-mcp").click();
  const section = page.getByTestId("mcp-section");
  await expect(section).toBeVisible();

  // The mock fixture has 2 servers: filesystem (connected) + github (disconnected).
  await expect(section).toContainText("filesystem");
  await expect(section).toContainText("connected");
  await expect(section).toContainText("github");
  await expect(section).toContainText("disconnected");
});

test("the MCP reconnect button updates server status", async ({ page }) => {
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-tab-mcp").click();

  // The github server starts disconnected. Assert the exact status span, not a
  // substring of the row — "disconnected" contains "connected", so a row-level
  // toContainText("connected") passes vacuously and would never catch a broken
  // reconnect round-trip.
  const status = page.getByTestId("mcp-server-github").locator(".mcp-status");
  await expect(status).toHaveText("disconnected");

  // Reconnect → the mock's SetMcpServer arm emits a sessionUpdated flipping github
  // to connected. This exercises the whole client→wire→hub→driver→arm path.
  await page.getByTestId("mcp-reconnect-github").click();
  await expect(status).toHaveText("connected");
});
