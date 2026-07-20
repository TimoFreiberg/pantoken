import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

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

test("ArrowRight/ArrowLeft toggles handoff locally without a daemon request", async ({
  page,
}) => {
  // Switch to Plan so the toggle is present.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  const before = await page.locator(".row.notice .ntext").count();

  // AC.2 — ArrowRight flips the pending toggle on locally; no new notice.
  await panel.press("ArrowRight");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toHaveClass(/on/);
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);

  // ArrowLeft flips it back off locally; still no new notice.
  await panel.press("ArrowLeft");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).not.toHaveClass(/on/);
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);

  // Commit with pending === session (both off) → no flush, no new notice.
  await panel.press("Enter");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);

  // Now test the guard against a REAL difference: toggle on, commit (flush
  // fires, +1), reopen, toggle on again, commit — the second commit must NOT
  // flush because the session is now on (pending === session).
  await page.getByTestId("facet-badge").click();
  await panel.press("ArrowRight");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await panel.press("Enter");
  // First flush: session was off, pending on → one new notice.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before + 1);

  // Reopen — toggle re-snapshots from session (now on).
  await page.getByTestId("facet-badge").click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // Toggle off then on again (pending ends at on, matching session).
  await panel.press("ArrowLeft");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await panel.press("ArrowRight");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // Commit: pending (on) === session (on) → no flush, no new notice.
  await panel.press("Enter");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before + 1);
});

test("committing the menu flushes the pending handoff change via click-select", async ({
  page,
}) => {
  // Switch to Plan, open the menu, toggle on locally, then commit by clicking
  // the Plan row (click-select path, not Enter).
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  const before = await page.locator(".row.notice .ntext").count();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);

  // Click-select the Plan row → commit flushes the pending handoff (one new
  // notice). Note: Plan is already active, so no setFacet notice — only the
  // handoff flush notice.
  await page.getByRole("option", { name: "Plan" }).click();
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

test("the handoff toggle hides while drafting a new session", async ({
  page,
}) => {
  // A draft has no live daemon session, so the per-session flag can't apply yet.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await page.getByTestId("facet-badge").click();
  await expect(page.getByRole("listbox", { name: "Facet" })).toBeVisible();
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
});
