import { expect, test } from "@playwright/test";
import { gotoFresh, openSettings } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("adventurous handoff toggle flips and persists in the session state", async ({
  page,
}) => {
  await openSettings(page, "appearance");
  const toggle = page.getByTestId("adventurous-handoff");

  // Default: off (the mock seeds adventurousHandoff: false).
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("Off");

  // Toggle on.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toContainText("On");

  // Toggle back off.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("Off");
});
