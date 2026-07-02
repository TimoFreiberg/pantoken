import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
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

  // The github server is disconnected — reconnect it.
  const reconnectBtn = page.getByTestId("mcp-reconnect-github");
  await expect(reconnectBtn).toBeVisible();
  await reconnectBtn.click();

  // The mock updates the status to "connected" via sessionUpdated.
  await expect(page.getByTestId("mcp-server-github")).toContainText("connected");
});
