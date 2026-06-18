import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the sidebar shows a build stamp (commit hash + date)", async ({
  page,
}) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  await expect(version).toBeVisible();
  // Value is non-deterministic (depends on the checkout's git state): either a short
  // hash optionally followed by a commit date, or the "dev" fallback if git wasn't
  // reachable at build time.
  await expect(version).toHaveText(
    /^([0-9a-f]{7,}( · \d{4}-\d{2}-\d{2})?|dev)$/,
  );
});
