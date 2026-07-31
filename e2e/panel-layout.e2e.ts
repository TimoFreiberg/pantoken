import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: the auto context panel collapses and reappears around the width
// budget, and an auto-hidden panel can be focused temporarily as an overlay.
test("auto context panel: collapses/reappears at the width budget and focuses temporarily", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "true");

  await page.setViewportSize({ width: 1087, height: 850 });
  await expect(panel).toHaveAttribute("data-open", "false");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("pantoken.rightSidebarPreference"),
    ),
  ).toBe("auto");

  await page.setViewportSize({ width: 1088, height: 850 });
  await expect(panel).toHaveAttribute("data-open", "true");

  // An auto-hidden panel can be focused temporarily (overlay, layout unchanged).
  await page.setViewportSize({ width: 1000, height: 850 });
  await expect(panel).toHaveAttribute("data-open", "false");
  const appBefore = await page.locator(".app").boundingBox();

  await page.getByTestId("context-open").click();
  await expect(panel).toHaveAttribute("data-open", "true");
  await expect(panel).toHaveAttribute("data-overlay", "true");
  const appAfter = await page.locator(".app").boundingBox();
  expect(appAfter).toEqual(appBefore);
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(Math.round(panelBox!.width)).toBe(280);
  expect(Math.round(panelBox!.x + panelBox!.width)).toBe(1000);
  expect(Math.round(panelBox!.height)).toBe(850);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("pantoken.rightSidebarPreference"),
    ),
  ).toBe("auto");

  await panel.getByRole("button", { name: "Collapse context panel" }).click();
  await expect(panel).toHaveAttribute("data-open", "false");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("pantoken.rightSidebarPreference"),
    ),
  ).toBe("auto");

  await page.getByTestId("context-open").click();

  await page.setViewportSize({ width: 1200, height: 850 });
  await expect(panel).toHaveAttribute("data-open", "true");
  await expect(panel).toHaveAttribute("data-overlay", "false");
});

// Journey: manual close remains closed after widening and reload
test("manual close remains closed after widening and reload", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  await page.getByRole("button", { name: "Collapse context panel" }).click();
  await expect(panel).toHaveAttribute("data-open", "false");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("pantoken.rightSidebarPreference"),
    ),
  ).toBe("closed");

  await page.setViewportSize({ width: 1500, height: 850 });
  await expect(panel).toHaveAttribute("data-open", "false");
  await page.reload();
  await expect(panel).toHaveAttribute("data-open", "false");
});

// Journey: legacy right-sidebar booleans migrate to the new preference
test("legacy right-sidebar booleans migrate to the new preference", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.removeItem("pantoken.rightSidebarPreference");
    localStorage.setItem("pantoken.rightSidebarOpen", "0");
  });
  await page.reload();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("pantoken.rightSidebarPreference"),
    ),
  ).toBe("closed");
});
