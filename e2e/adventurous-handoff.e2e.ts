import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("toggling handoff in the open menu does not send a request until commit", async ({
  page,
}) => {
  // The toggle lives in the facet picker (it's a plan-mode modifier in spirit),
  // next to the composer — per-session config near the prompt box.
  await page.getByTestId("facet-badge").click();
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toBeVisible();

  // Default: off (the mock seeds adventurousHandoff: false).
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toHaveAttribute("aria-label", "Adventurous handoff");

  // Snapshot the notice count AFTER switching to Plan (that switch itself emits
  // a notice). Subsequent assertions check the DELTA — no new notice means no
  // request was sent.
  const before = await page.locator(".row.notice .ntext").count();

  // AC.1 — clicking the toggle flips the LOCAL pending state only; no daemon
  // request fires while the menu is open, so no new notice appears.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toHaveClass(/on/);
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);

  // AC.3 — committing via Enter flushes the pending change: exactly one new
  // notice appears (the toggle was on, session was off → one flush).
  await page.getByRole("listbox", { name: "Facet" }).press("Enter");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before + 1);
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Adventurous handoff enabled",
  );
});

test("aborting the menu discards the pending handoff change", async ({
  page,
}) => {
  // Switch to Plan, open the menu, toggle on locally, then abort via Escape.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  const before = await page.locator(".row.notice .ntext").count();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);

  // AC.4 — Escape aborts; no flush, no new notice.
  await panel.press("Escape");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);

  // Reopen — the toggle re-snapshots from the session (still off).
  await page.getByTestId("facet-badge").click();
  await expect(page.getByTestId("adventurous-handoff")).toHaveAttribute(
    "aria-checked",
    "false",
  );
});
