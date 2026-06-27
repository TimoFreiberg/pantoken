import { expect, type Locator, test } from "@playwright/test";
import { drive, gotoFresh, openSettings } from "./helpers.js";

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
  // Only the active section renders, so navigate to each one before checking its
  // disclosure header. The section-nav rail tabs themselves are also touch targets.
  await openSettings(page, "appearance");
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  // The rail tabs reflow to a horizontal strip on the phone bottom-sheet but stay
  // comfortably tappable (coarse pointer bumps them to a full 44px).
  for (const id of ["appearance", "providers", "models", "extensions"])
    await expectTall(page.getByTestId(`settings-tab-${id}`));

  // The Favorites disclosure header (nested under the Models tab) is the primary
  // collapse affordance — on the phone bottom-sheet it must be comfortably tappable.
  // (Providers and Extensions used to have their own collapse toggles, but each got its
  // own tab in the redesign, so their lists are always shown — no toggle to tap.)
  await page.getByTestId("settings-tab-models").click();
  await expectTall(page.getByTestId("favorites-toggle"));
});
