import { expect, test } from "@playwright/test";
import { gotoFresh, openRightSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// The right sidebar's MCP servers section lists both mock servers with status
// dots and tool counts, and a /mcp command round-trip flips a disconnected
// server to connected.
test("right sidebar shows MCP servers with status dots and /mcp updates the dot", async ({
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

  // github starts disconnected.
  await expect(ghRow.locator(".mcp-dot")).toHaveClass(/mcp-disconnected/);

  // Dispatch via the composer /mcp command.
  const box = page.locator(".composer-wrap textarea");
  await box.fill("/mcp github enable");
  await box.press("Enter");

  // The mock maps enable → Connected; the sidebar dot flips.
  await expect(ghRow.locator(".mcp-dot")).toHaveClass(/mcp-connected/);
});

// The Settings → MCP tab lists configured servers with their status, and the
// reconnect button drives a full client→wire→hub→driver round-trip that flips
// a disconnected server to connected.
test("settings MCP tab shows configured servers and reconnect updates status", async ({
  page,
}) => {
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
