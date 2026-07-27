import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// The scope controls (permission, facet, model badges) live in the composer's
// status row on a live session. Under create-on-click (phase 3), the draft-only
// scope-row (with its draft-project-control project chip) no longer renders —
// the chooser handles project selection instead. This test verifies the live
// session's composer chrome is intact.
test("scope controls render in the composer status row on a live session", async ({
  page,
}) => {
  // The draft-only scope-row and project chip should not be present.
  await expect(page.getByTestId("draft-setup")).toHaveCount(0);
  await expect(page.getByTestId("draft-project-control")).toHaveCount(0);
  await expect(page.getByTestId("scope-row")).toHaveCount(0);

  const status = page.getByTestId("composer-status-row");
  await expect(status).toBeVisible();
  await expect(status.getByTestId("permission-badge")).toBeVisible();
  await expect(status.getByTestId("facet-badge")).toBeVisible();
  await expect(status.getByTestId("model-badge")).toBeVisible();

  // The composer surface is visible (the live session's input box).
  await expect(page.getByTestId("composer-surface")).toBeVisible();
});
