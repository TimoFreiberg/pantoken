import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the sidebar shows a compact version label (tag or short hash)", async ({
  page,
}) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  await expect(version).toBeVisible();
  // After the redesign the footer shows only the version: the release tag
  // (vX.Y.Z), the short hash, or the "dev" fallback if git was unreachable at
  // build time. The full "tag · hash · date" stamp moved into the hover pop-up.
  // useInnerText: Svelte collapses whitespace, so textContent can carry a leading
  // space (" dev"). innerText is the *rendered* text the user actually sees.
  await expect(version).toHaveText(/^(v[\w.-]+|[0-9a-f]{7,}|dev)$/, {
    useInnerText: true,
  });
});
