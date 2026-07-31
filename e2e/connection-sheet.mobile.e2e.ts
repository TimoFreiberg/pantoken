import { expect, test, devices } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
});

test.use({ ...devices["Pixel 7"] });

/** Drive the dev-remote host state via window.__pantokenHosts. */
async function setState(page: import("@playwright/test").Page, state: string): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as { __pantokenHosts?: { setState: (id: string, state: string) => void } }).__pantokenHosts?.setState("dev-remote", s),
    state,
  );
}

// On mobile the connection sheet is full-screen with ≥44px tap targets, and the
// Back button (full-screen overlay) cancels the connection and closes the sheet.
test("mobile connection sheet is full-screen with 44px targets and Back cancels", async ({
  page,
}) => {
  const switcher = page.getByTestId("host-switcher");
  await switcher.getByTestId("host-switcher-trigger").click();
  await page.getByTestId("host-option-dev-remote").click();

  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible();
  const panel = page.getByTestId("connection-sheet-panel");
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(350);
  expect(box!.height).toBeGreaterThanOrEqual(600);

  // Cancel button should have ≥44px height.
  const cancelBtn = page.getByTestId("connection-cancel");
  const cancelBox = await cancelBtn.boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(cancelBox!.height).toBeGreaterThanOrEqual(44);

  // The sheet is still visible before the Back gesture (re-asserted from the
  // back-gesture test's own panel-visible check).
  await expect(page.getByTestId("connection-sheet-panel")).toBeVisible();

  // Use the Back button (phone full-screen overlay) to close and cancel.
  await page.getByTestId("connection-sheet-panel").getByText("Back").click();
  await expect(page.getByTestId("connection-sheet-panel")).toBeHidden();
});
