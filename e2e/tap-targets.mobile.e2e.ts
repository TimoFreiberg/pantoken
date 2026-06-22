import { expect, type Locator, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Runs under the "mobile" project (Pixel 7 → coarse pointer + touch).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function expectTall(loc: Locator, min = 44) {
  const box = await loc.boundingBox();
  expect(box, "element should be laid out").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(min);
}

test("blocking dialog actions meet the 44px touch target", async ({ page }) => {
  await drive(page, "confirm");
  const dialog = page.getByRole("dialog");
  await expectTall(dialog.getByRole("button", { name: "Allow" }));
  await expectTall(dialog.getByRole("button", { name: "Deny" }));
});

test("non-binary select options meet the 44px touch target", async ({
  page,
}) => {
  await drive(page, "selectmany");
  const options = page.getByRole("dialog").getByRole("radio");
  await expect(options).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expectTall(options.nth(i));
});

test("settings collapse headers meet the 44px touch target", async ({
  page,
}) => {
  await page.getByTestId("settings-toggle").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  // The Providers / Favorites / Extensions disclosure headers are the primary
  // collapse affordance — on the phone bottom-sheet they must be comfortably tappable.
  await expectTall(page.getByTestId("providers-toggle"));
  await expectTall(page.getByTestId("favorites-toggle"));
  await expectTall(page.getByTestId("extensions-toggle"));
});
