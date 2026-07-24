import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

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

test("the handoff toggle is visible while drafting (Plan facet) and defaults to off", async ({
  page,
}) => {
  // A fresh draft defaults to Execute — the toggle only appears on the Plan row.
  // After switching to Plan, the toggle should be visible and off.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await page.getByTestId("facet-badge").click();
  await expect(page.getByRole("listbox", { name: "Facet" })).toBeVisible();
  // Execute is active — no Plan row, so no toggle yet.
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
  // Switch to Plan — the toggle appears.
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("toggling handoff in a draft does not send a daemon request", async ({
  page,
}) => {
  // AC.5 — while drafting, the toggle edits store.draft.adventurousHandoff only;
  // no daemon request fires, so no "Adventurous handoff enabled" notice appears.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  // Switch to Plan so the toggle appears.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // The draft transcript starts empty — no notices.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(0);

  // Toggle on — no daemon request, no notice.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(0);

  // Toggle back off — still no notice.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".row.notice .ntext")).toHaveCount(0);
});

test("adventurous handoff toggled in draft fires after session creation", async ({
  page,
}) => {
  // AC.3 — toggling handoff on in a draft, then creating the session, fires the
  // post-creation toggle and the "Adventurous handoff enabled" notice appears.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  // Switch to Plan and toggle handoff on.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // Submit the draft — the session is created and the post-creation toggle fires.
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("get started");
  await composer.press("Enter");

  // The "Adventurous handoff enabled" notice appears (post-creation toggle).
  await expect(
    page.locator(".row.notice .ntext").filter({ hasText: "Adventurous handoff enabled" }),
  ).toBeVisible({ timeout: 10000 });
});

test("draft with handoff off does not fire a toggle after creation", async ({
  page,
}) => {
  // AC.4 — when the draft has handoff OFF (default), no toggle fires after
  // creation, so no "Adventurous handoff enabled" notice appears.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  // Switch to Plan (toggle appears) but leave it OFF.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("get started");
  await composer.press("Enter");

  // Wait for the session to start — the draft view is replaced by the live
  // transcript (the "new-session" panel disappears).
  await expect(page.getByTestId("new-session")).toHaveCount(0, { timeout: 10000 });

  // No "Adventurous handoff enabled" notice.
  await expect(
    page.locator(".row.notice .ntext").filter({ hasText: "Adventurous handoff enabled" }),
  ).toHaveCount(0);
});

test("draft handoff toggle persists across reload", async ({ page }) => {
  // AC.2 — toggling handoff on in a draft stores it in draftConfigMap, so it
  // survives a page reload.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  // Switch to Plan and toggle handoff on.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // Close the facet menu before reloading so its backdrop doesn't linger.
  await page.keyboard.press("Escape");

  // Reload — the draft config persists in localStorage, but the draft itself
  // isn't restored on reload (the server re-focuses the last session). Re-open
  // a new-session draft at the same cwd to restore the persisted config.
  await page.reload();
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  // Switch to Plan again to see the toggle.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  await expect(page.getByTestId("adventurous-handoff")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("failed new session with handoff on restores the toggle", async ({
  page,
}) => {
  // AC.6 — a failed new-session creation that had handoff toggled on restores
  // the toggle state in the recovered draft.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  // Switch to Plan and toggle handoff on.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // Arm the one-shot creation failure. Close the facet menu first so the
  // backdrop doesn't intercept the dev-bar button click.
  await page.keyboard.press("Escape");
  await drive(page, "failnewsession");

  // Submit — creation fails, draft auto-restores.
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("the doomed session");
  await composer.press("Enter");

  // The draft comes back — switch to Plan and verify the toggle is still on.
  await expect(composer).toHaveValue("the doomed session");
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  await expect(page.getByTestId("adventurous-handoff")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
