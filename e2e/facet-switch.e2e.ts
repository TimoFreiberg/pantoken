import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The facet picker (in the composer chrome) switches the active facet. Clicking
// it sends a setFacet wire message → the mock emits a sessionUpdated snapshot
// with the new facet → foldEvent propagates → the badge updates. The badge shows
// the ACTUAL current facet ("Execute"/"Plan"), not the old affordance label.
// Shift+Tab opens the dropdown on the current facet (no rotation); repeated
// Shift+Tab moves the highlight through entries; Enter commits; Escape aborts;
// other typed letters are a noop. Number keys (1-9) quick-select inside the
// open dropdown.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("clicking the facet badge opens a picker and switching works", async ({
  page,
}) => {
  // The badge shows the actual facet: "Execute" in the default (execute) state.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Execute");

  // Click the badge → opens the dropdown picker. Click "Plan" to switch.
  await badge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toHaveText("Plan");
  await expect(badge).toHaveClass(/facet-(plan|auto)/);

  // Click the badge → opens the picker again. Click "Execute" to switch back.
  await badge.click();
  await page.getByRole("option", { name: "Execute" }).click();
  await expect(badge).toHaveText("Execute");
  await expect(badge).not.toHaveClass(/facet-(plan|auto)/);
});

test("the facet badge sits to the right of permission in the composer footer", async ({
  page,
}) => {
  const left = page.locator("[data-testid='composer-status-row'] .status-left");
  const permissionBox = await left
    .getByTestId("permission-badge")
    .boundingBox();
  const facetBox = await left.getByTestId("facet-badge").boundingBox();
  expect(permissionBox).not.toBeNull();
  expect(facetBox).not.toBeNull();
  expect(facetBox!.x).toBeGreaterThan(permissionBox!.x);
  expect(Math.abs(facetBox!.y - permissionBox!.y)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("composer-facet-slot")).toHaveCount(0);
});

test("number key quick-selects a facet from the open dropdown", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Open the dropdown via the badge.
  await badge.click();
  const panel = page.locator(".panel[role='listbox']");
  await expect(panel).toBeVisible();

  // Press "2" → selects the 2nd facet (plan). Panel closes, badge updates.
  await page.keyboard.press("2");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Plan");

  // Open again, press "1" → back to execute.
  await badge.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("1");
  await expect(badge).toHaveText("Execute");

  // Open again, press "3" → research.
  await badge.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("3");
  await expect(badge).toHaveText("Research");
});

test("highlighting Plan while Execute is active does not expose or toggle handoff", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  const plan = panel.getByRole("option", { name: /Plan/ });
  await panel.press("ArrowDown");
  await expect(plan).toHaveClass(/hl/);
  await expect(badge).toHaveText("Execute");
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
  await panel.press("ArrowRight");
  await panel.press("ArrowLeft");
  await expect(badge).toHaveText("Execute");
  await expect(page.getByTestId("adventurous-handoff")).toHaveCount(0);
  await expect(panel).toBeFocused();
});

test("Right and Left toggle Plan handoff locally without a daemon request", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await badge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await panel.press("ArrowRight");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await panel.press("ArrowRight");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(panel).toBeFocused();

  await panel.press("ArrowLeft");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await panel.press("ArrowLeft");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(badge).toHaveText("Plan");
});

test("Shift+Tab opens the menu without rotating; repeated Shift+Tab moves the highlight", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Focus the composer textarea — Shift+Tab opens the facet menu on the CURRENT
  // facet (no rotation, no commit), moving focus into the panel.
  await page.getByPlaceholder("Message pantoken…").focus();

  await page.keyboard.press("Shift+Tab");
  // Badge unchanged on first press — no rotation.
  await expect(badge).toHaveText("Execute");
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  // The facets in order: Execute(0), Plan(1), Research(2). The menu opens with
  // sel at the current facet (Execute, index 0). Shift+Tab moves the highlight
  // to the next entry (Plan, index 1) — badge still "Execute" (no commit).
  const planOption = panel.getByRole("option", { name: "Plan" });
  await page.keyboard.press("Shift+Tab");
  await expect(planOption).toHaveClass(/hl/);
  await expect(badge).toHaveText("Execute");
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  // Shift+Tab again — highlight moves to Research (index 2). Badge unchanged.
  const researchOption = panel.getByRole("option", { name: "Research" });
  await page.keyboard.press("Shift+Tab");
  await expect(researchOption).toHaveClass(/hl/);
  await expect(badge).toHaveText("Execute");
  await expect(panel).toBeVisible();

  // Shift+Tab wraps back to Execute (index 0).
  const executeOption = panel.getByRole("option", { name: "Execute" });
  await page.keyboard.press("Shift+Tab");
  await expect(executeOption).toHaveClass(/hl/);
  await expect(badge).toHaveText("Execute");

  // Enter commits the highlighted facet (Execute) and closes the menu.
  await page.keyboard.press("Enter");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Execute");
});

test("the facet panel stays anchored (left edge stable) when cycling with Shift+Tab", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Focus the composer textarea, then Shift+Tab to open the facet menu (no
  // rotation — badge stays "Execute"). The panel opens upward and is
  // left-anchored to the badge.
  await page.getByPlaceholder("Message pantoken…").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
  const panel = page.getByRole("listbox", { name: "Facet" });
  // Wait for the panel to settle: visible, then focused (focus moves in after
  // open — this also lets the reveal transition finish before measuring).
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  // The panel's left edge should align with the badge's left edge (left-anchored).
  const panelBox1 = await panel.boundingBox();
  const badgeBox1 = await badge.boundingBox();
  expect(panelBox1).not.toBeNull();
  expect(badgeBox1).not.toBeNull();
  expect(Math.abs(panelBox1!.x - badgeBox1!.x)).toBeLessThanOrEqual(1);

  // Shift+Tab again (highlight moves to Plan, no commit) — the panel's left
  // edge must not move. Badge unchanged.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
  await expect(panel).toBeVisible();
  const panelBox2 = await panel.boundingBox();
  expect(panelBox2).not.toBeNull();
  expect(panelBox2!.x).toBe(panelBox1!.x);

  // Shift+Tab again (highlight moves to Research) — still stable.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
  await expect(panel).toBeVisible();
  const panelBox3 = await panel.boundingBox();
  expect(panelBox3).not.toBeNull();
  expect(panelBox3!.x).toBe(panelBox1!.x);
});

test("arrow keys navigate the open facet menu and Enter selects", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Open the menu via badge click (no rotation, sel starts at Execute).
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();

  // ArrowDown highlights the next option (Plan, index 1).
  const planOption = panel.getByRole("option", { name: /Plan/ });
  await page.keyboard.press("ArrowDown");
  await expect(planOption).toHaveClass(/hl/);

  // Enter selects the highlighted option and closes the menu.
  await page.keyboard.press("Enter");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Plan");
  // Issue #54: closing the facet menu returns focus to the composer textarea.
  await expect(page.getByPlaceholder("Message pantoken…")).toBeFocused();
});

test("Escape closes the facet menu without changing the facet", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Shift+Tab opens the menu WITHOUT rotating — badge still "Execute".
  await page.getByPlaceholder("Message pantoken…").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();

  // Move the highlight to Plan (no commit).
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByRole("option", { name: "Plan" })).toHaveClass(/hl/);
  await expect(badge).toHaveText("Execute");

  // Escape closes the menu without committing the highlight — badge stays
  // "Execute" (Escape aborts; the highlight was never committed).
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText("Execute");
  // Issue #54: closing the facet menu returns focus to the composer textarea.
  await expect(page.getByPlaceholder("Message pantoken…")).toBeFocused();
});

test("typing a letter from the open facet menu is a noop", async ({ page }) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  const textarea = page.getByPlaceholder("Message pantoken…");
  await textarea.focus();

  // Shift+Tab opens the menu (no rotation — badge stays "Execute").
  await page.keyboard.press("Shift+Tab");
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  // Type "h" — the menu must stay open, focus stays in the panel, and "h" is
  // NOT inserted into the composer textarea (a noop, not a forward-and-dismiss).
  await page.keyboard.press("h");
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(textarea).toHaveValue("");
});

test("the handoff slide-toggle is inline on the Plan row, not a separate line", async ({
  page,
}) => {
  // Switch to Plan first so the toggle is present when the menu opens.
  const badge = page.getByTestId("facet-badge");
  await badge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toHaveText("Plan");

  // Open the menu — the handoff toggle is inside the Plan row (.plan-row).
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  const planRow = panel.locator(".plan-row");
  await expect(planRow).toBeVisible();
  const toggle = page.getByTestId("adventurous-handoff");
  await expect(toggle).toBeVisible();
  // The toggle is a child of the Plan row, not a separate sibling.
  await expect(planRow.getByTestId("adventurous-handoff")).toBeVisible();

  // Clicking the toggle toggles handoff and keeps the menu open (stopPropagation).
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveClass(/on/);

  // No .handoff-pill should exist — it was replaced by the slide-toggle.
  await expect(page.locator(".handoff-pill")).toHaveCount(0);
});

test("FacetBadge tooltip names the Shift+Tab hotkey", async ({ page }) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveAttribute("title", /⇧Tab/);
});

test("Shift+Tab does not fire when the slash menu is open", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Focus the composer and open the slash menu.
  const box = page.getByPlaceholder("Message pantoken…");
  await box.focus();
  await box.press("/");
  // The slash menu should be visible.
  await expect(page.locator("#slash-menu")).toBeVisible();

  // Shift+Tab while the slash menu is open — the slash block matches
  // `e.key === "Tab"` (no shift guard) and returns early (accepts the slash
  // command), so the facet-rotate branch is never reached. The facet must NOT
  // rotate.
  await box.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
});

// Regression: opening the facet menu via Shift+Tab and closing it, then switching
// sessions (which unmounts + remounts Composer via App.svelte's {#if} block),
// must NOT auto-pop the facet menu. Root cause: MenuBadge's lastOpenN was reset
// to 0 on remount while store.facetMenuOpenN (monotonic, never reset) still
// held a prior value > 0, so the effect re-fired open=true. Fixed by making
// lastOpenN a null sentinel that syncs on the first post-(re)mount observation
// without opening.
test("the facet menu does not auto-open after a Composer remount", async ({
  page,
}) => {
  // Open the facet menu once via Shift+Tab, then close it.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await page.getByPlaceholder("Message pantoken…").focus();
  await page.keyboard.press("Shift+Tab");
  // No rotation — badge stays "Execute".
  await expect(badge).toHaveText("Execute");
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Switch to a different session — this unmounts and remounts Composer,
  // resetting MenuBadge's local state. The greeting session's facet is
  // unchanged ("Execute") since Shift+Tab no longer rotates.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .locator(".row", { hasText: "Explore the fold reducer" })
    .click();
  // Composer is remounted against the existing session.
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();

  // The facet menu must NOT have auto-popped on the remount.
  await expect(page.getByRole("listbox", { name: "Facet" })).toHaveCount(0);

  // A fresh Shift+Tab still opens the menu (without rotating).
  await page.getByPlaceholder("Message pantoken…").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
  await expect(page.getByRole("listbox", { name: "Facet" })).toBeVisible();
});
