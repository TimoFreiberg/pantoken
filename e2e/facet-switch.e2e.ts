import { expect, test } from '@playwright/test';
import { gotoFresh, openSidebar, openSettings } from './helpers.js';

// The facet picker (in the composer chrome) switches the active facet. Clicking
// it sends a setFacet wire message → the mock emits a sessionUpdated snapshot
// with the new facet → foldEvent propagates → the badge updates. The badge shows
// the ACTUAL current facet ("Execute"/"Plan"), not the old affordance label.
// Shift+Tab opens the dropdown on the current facet (no rotation); repeated
// Shift+Tab moves the highlight through entries; Enter commits; Escape aborts;
// other typed letters are a noop. Number keys (1-9) quick-select inside the
// open dropdown. Selecting the already-active facet (Enter / click / number-key)
// is a no-op — no setFacet wire message, so no "Facet switched to X" notice.
// The reload button lives in Settings → Environment, not the facet menu.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: examine the facet badge — its Shift+Tab tooltip, its position relative
// to the permission badge in the composer footer — then click-switch Execute →
// Plan → Execute, verifying badge text/class, and that switching to a different
// facet emits a "Facet switched" notice (regression guard for the setFacet
// request).
test('the facet badge: tooltip, position, and click-switching with notice check', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');

  // The badge shows the actual facet: "Execute" in the default (execute) state.
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Execute');

  // The tooltip names the Shift+Tab hotkey.
  await expect(badge).toHaveAttribute('title', /⇧Tab/);

  // The badge sits to the right of the permission badge in the composer footer.
  const left = page.locator("[data-testid='composer-status-row'] .status-left");
  const permissionBox = await left
    .getByTestId('permission-badge')
    .boundingBox();
  const facetBox = await left.getByTestId('facet-badge').boundingBox();
  expect(permissionBox).not.toBeNull();
  expect(facetBox).not.toBeNull();
  expect(facetBox!.x).toBeGreaterThan(permissionBox!.x);
  expect(Math.abs(facetBox!.y - permissionBox!.y)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('composer-facet-slot')).toHaveCount(0);

  // Click the badge → opens the dropdown picker. Click "Plan" to switch.
  await badge.click();
  await page.getByRole('option', { name: 'Plan' }).click();
  await expect(badge).toHaveText('Plan');
  await expect(badge).toHaveClass(/facet-(plan|auto)/);

  // Click the badge → opens the picker again. Click "Execute" to switch back.
  await badge.click();
  await page.getByRole('option', { name: 'Execute' }).click();
  await expect(badge).toHaveText('Execute');
  await expect(badge).not.toHaveClass(/facet-(plan|auto)/);

  // Switching to a *different* facet still sends the setFacet request and
  // produces a new notice (regression guard).
  await expect(badge).toHaveText('Execute');
  const before = await page.locator('.row.notice .ntext').count();
  await badge.click();
  await page.getByRole('option', { name: 'Plan' }).click();
  await expect(badge).toHaveText('Plan');
  // The mock emits a "Facet switched to plan" notice on a real setFacet.
  await expect(page.locator('.row.notice .ntext')).toHaveCount(before + 1);
  await expect(page.locator('.row.notice .ntext').last()).toContainText(
    /plan/i,
  );
});

// Journey: open the facet dropdown and use Enter / number keys to select facets.
// Selecting the already-active facet (Enter or its number key) is a noop — no
// setFacet request, so no new notice appears. Switching to a different facet
// updates the badge.
test('number-key and Enter selection; selecting the active facet is a noop', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');

  // Open the dropdown via the badge. Enter on the active facet (Execute) is a noop.
  await badge.click();
  const panel = page.getByRole('listbox', { name: 'Facet' });
  await expect(panel).toBeVisible();
  // Execute is index 0 — the default highlight.
  await expect(panel.getByRole('option', { name: 'Execute' })).toHaveClass(/hl/);
  const beforeEnter = await page.locator('.row.notice .ntext').count();
  await panel.press('Enter');
  await expect(panel).not.toBeVisible();
  // No new "Facet switched to execute" notice — the request was suppressed.
  await expect(page.locator('.row.notice .ntext')).toHaveCount(beforeEnter);
  await expect(badge).toHaveText('Execute');

  // Open again, press "1" (Execute's number key) — also a noop.
  await expect(badge).toHaveText('Execute');
  await badge.click();
  await expect(panel).toBeVisible();
  const beforeNum = await page.locator('.row.notice .ntext').count();
  await page.keyboard.press('1');
  await expect(panel).not.toBeVisible();
  await expect(page.locator('.row.notice .ntext')).toHaveCount(beforeNum);
  await expect(badge).toHaveText('Execute');

  // Open again, press "2" → selects the 2nd facet (plan). Panel closes, badge updates.
  await expect(badge).toHaveText('Execute');
  await badge.click();
  const dropdownPanel = page.locator(".panel[role='listbox']");
  await expect(dropdownPanel).toBeVisible();
  await page.keyboard.press('2');
  await expect(dropdownPanel).not.toBeVisible();
  await expect(badge).toHaveText('Plan');

  // Open again, press "1" → back to execute.
  await badge.click();
  await expect(dropdownPanel).toBeVisible();
  await page.keyboard.press('1');
  await expect(badge).toHaveText('Execute');

  // Open again, press "3" → research.
  await badge.click();
  await expect(dropdownPanel).toBeVisible();
  await page.keyboard.press('3');
  await expect(badge).toHaveText('Research');
});

// Journey: Shift+Tab opens the facet menu on the current facet (no rotation),
// repeated Shift+Tab moves the highlight through entries, and Enter commits the
// highlighted facet.
test('Shift+Tab opens the facet menu and cycles the highlight through entries; Enter commits', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');

  // Focus the composer textarea — Shift+Tab opens the facet menu on the CURRENT
  // facet (no rotation, no commit), moving focus into the panel.
  await page.getByPlaceholder('Message pantoken…').focus();

  await page.keyboard.press('Shift+Tab');
  // Badge unchanged on first press — no rotation.
  await expect(badge).toHaveText('Execute');
  const panel = page.getByRole('listbox', { name: 'Facet' });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  // The facets in order: Execute(0), Plan(1), Research(2). The menu opens with
  // sel at the current facet (Execute, index 0). Shift+Tab moves the highlight
  // to the next entry (Plan, index 1) — badge still "Execute" (no commit).
  const planOption = panel.getByRole('option', { name: 'Plan' });
  await page.keyboard.press('Shift+Tab');
  await expect(planOption).toHaveClass(/hl/);
  await expect(badge).toHaveText('Execute');
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  // Shift+Tab again — highlight moves to Research (index 2). Badge unchanged.
  const researchOption = panel.getByRole('option', { name: 'Research' });
  await page.keyboard.press('Shift+Tab');
  await expect(researchOption).toHaveClass(/hl/);
  await expect(badge).toHaveText('Execute');
  await expect(panel).toBeVisible();

  // Shift+Tab wraps back to Execute (index 0).
  const executeOption = panel.getByRole('option', { name: 'Execute' });
  await page.keyboard.press('Shift+Tab');
  await expect(executeOption).toHaveClass(/hl/);
  await expect(badge).toHaveText('Execute');

  // Enter commits the highlighted facet (Execute) and closes the menu.
  await page.keyboard.press('Enter');
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText('Execute');
});

// Journey: the facet panel opens upward and is left-anchored to the badge. While
// cycling the highlight with Shift+Tab, the panel's left edge must not move.
test('the facet panel stays left-anchored to the badge when cycling with Shift+Tab', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');

  // Focus the composer textarea, then Shift+Tab to open the facet menu (no
  // rotation — badge stays "Execute"). The panel opens upward and is
  // left-anchored to the badge.
  await page.getByPlaceholder('Message pantoken…').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(badge).toHaveText('Execute');
  const panel = page.getByRole('listbox', { name: 'Facet' });
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
  await page.keyboard.press('Shift+Tab');
  await expect(badge).toHaveText('Execute');
  await expect(panel).toBeVisible();
  const panelBox2 = await panel.boundingBox();
  expect(panelBox2).not.toBeNull();
  expect(panelBox2!.x).toBe(panelBox1!.x);

  // Shift+Tab again (highlight moves to Research) — still stable.
  await page.keyboard.press('Shift+Tab');
  await expect(badge).toHaveText('Execute');
  await expect(panel).toBeVisible();
  const panelBox3 = await panel.boundingBox();
  expect(panelBox3).not.toBeNull();
  expect(panelBox3!.x).toBe(panelBox1!.x);
});

// Journey: arrow keys navigate the open facet menu and Enter selects the
// highlighted option. Closing the menu returns focus to the composer textarea.
test('arrow keys navigate the open facet menu and Enter selects', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');

  // Open the menu via badge click (no rotation, sel starts at Execute).
  await badge.click();
  const panel = page.getByRole('listbox', { name: 'Facet' });
  await expect(panel).toBeVisible();

  // ArrowDown highlights the next option (Plan, index 1).
  const planOption = panel.getByRole('option', { name: /Plan/ });
  await page.keyboard.press('ArrowDown');
  await expect(planOption).toHaveClass(/hl/);

  // Enter selects the highlighted option and closes the menu.
  await page.keyboard.press('Enter');
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText('Plan');
  // Issue #54: closing the facet menu returns focus to the composer textarea.
  await expect(page.getByPlaceholder('Message pantoken…')).toBeFocused();
});

// Journey: highlighting Plan while Execute is the active facet must not expose or
// toggle the adventurous-handoff control. ArrowRight/Left on the Execute-active
// menu are also noops for handoff.
test('highlighting Plan while Execute is active does not expose or toggle handoff', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await badge.click();
  const panel = page.getByRole('listbox', { name: 'Facet' });
  const plan = panel.getByRole('option', { name: /Plan/ });
  await panel.press('ArrowDown');
  await expect(plan).toHaveClass(/hl/);
  await expect(badge).toHaveText('Execute');
  await expect(page.getByTestId('adventurous-handoff')).toHaveCount(0);
  await panel.press('ArrowRight');
  await panel.press('ArrowLeft');
  await expect(badge).toHaveText('Execute');
  await expect(page.getByTestId('adventurous-handoff')).toHaveCount(0);
  await expect(panel).toBeFocused();
});

// Journey: switch to Plan, open the menu, and exercise the adventurous-handoff
// slide-toggle — both via keyboard (ArrowRight/Left) and via click. The toggle
// is inline on the Plan row, toggles locally without a daemon request, and keeps
// the menu open (stopPropagation). No .handoff-pill should exist.
test('Right/Left toggle Plan handoff locally; the toggle is inline on the Plan row', async ({ page }) => {
  // Switch to Plan first so the toggle is present when the menu opens.
  const badge = page.getByTestId('facet-badge');
  await badge.click();
  await page.getByRole('option', { name: 'Plan' }).click();
  await expect(badge).toHaveText('Plan');

  // Open the menu — the handoff toggle is inside the Plan row (.plan-row).
  await badge.click();
  const panel = page.getByRole('listbox', { name: 'Facet' });
  const planRow = panel.locator('.plan-row');
  await expect(planRow).toBeVisible();
  const toggle = page.getByTestId('adventurous-handoff');
  await expect(toggle).toBeVisible();
  // The toggle is a child of the Plan row, not a separate sibling.
  await expect(planRow.getByTestId('adventurous-handoff')).toBeVisible();

  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // ArrowRight toggles handoff on (locally, no daemon request).
  await panel.press('ArrowRight');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await panel.press('ArrowRight');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(panel).toBeFocused();

  // ArrowLeft toggles back off.
  await panel.press('ArrowLeft');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await panel.press('ArrowLeft');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(badge).toHaveText('Plan');

  // The toggle started unchecked — re-verify the initial state before the click
  // path (covers the separate initial-state check from the click-toggle flow).
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // Clicking the toggle toggles handoff and keeps the menu open (stopPropagation).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveClass(/on/);
  // No .handoff-pill should exist — it was replaced by the slide-toggle.
  await expect(page.locator('.handoff-pill')).toHaveCount(0);
});

// Journey: Shift+Tab opens the facet menu and typing a letter is a noop — the
// menu stays open, focus stays in the panel, and nothing is inserted into the
// composer textarea.
test('typing a letter from the open facet menu is a noop', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');

  const textarea = page.getByPlaceholder('Message pantoken…');
  await textarea.focus();

  // Shift+Tab opens the menu (no rotation — badge stays "Execute").
  await page.keyboard.press('Shift+Tab');
  await expect(badge).toHaveText('Execute');
  const panel = page.getByRole('listbox', { name: 'Facet' });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  // Type "h" — the menu must stay open, focus stays in the panel, and "h" is
  // NOT inserted into the composer textarea (a noop, not a forward-and-dismiss).
  await page.keyboard.press('h');
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(textarea).toHaveValue('');
});

// Journey: Shift+Tab opens the facet menu, move the highlight to Plan, then
// Escape closes the menu without committing — the badge stays "Execute" and
// focus returns to the composer textarea.
test('Escape closes the facet menu without changing the facet', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');

  // Shift+Tab opens the menu WITHOUT rotating — badge still "Execute".
  await page.getByPlaceholder('Message pantoken…').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(badge).toHaveText('Execute');
  const panel = page.getByRole('listbox', { name: 'Facet' });
  await expect(panel).toBeVisible();

  // Move the highlight to Plan (no commit).
  await page.keyboard.press('Shift+Tab');
  await expect(panel.getByRole('option', { name: 'Plan' })).toHaveClass(/hl/);
  await expect(badge).toHaveText('Execute');

  // Escape closes the menu without committing the highlight — badge stays
  // "Execute" (Escape aborts; the highlight was never committed).
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(badge).toHaveText('Execute');
  // Issue #54: closing the facet menu returns focus to the composer textarea.
  await expect(page.getByPlaceholder('Message pantoken…')).toBeFocused();
});

// Journey: when the slash menu is open, Shift+Tab must not fire the facet-rotate
// branch (the slash command block matches Tab without a shift guard and returns
// early). The facet badge must not rotate.
test('Shift+Tab does not fire when the slash menu is open', async ({ page }) => {
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');

  // Focus the composer and open the slash menu.
  const box = page.getByPlaceholder('Message pantoken…');
  await box.focus();
  await box.press('/');
  // The slash menu should be visible.
  await expect(page.locator('#slash-menu')).toBeVisible();

  // Shift+Tab while the slash menu is open — the slash block matches
  // `e.key === "Tab"` (no shift guard) and returns early (accepts the slash
  // command), so the facet-rotate branch is never reached. The facet must NOT
  // rotate.
  await box.press('Shift+Tab');
  await expect(badge).toHaveText('Execute');
});

// Regression: opening the facet menu via Shift+Tab and closing it, then switching
// sessions (which unmounts + remounts Composer via App.svelte's {#if} block),
// must NOT auto-pop the facet menu. Root cause: MenuBadge's lastOpenN was reset
// to 0 on remount while store.facetMenuOpenN (monotonic, never reset) still
// held a prior value > 0, so the effect re-fired open=true. Fixed by making
// lastOpenN a null sentinel that syncs on the first post-(re)mount observation
// without opening.
test('the facet menu does not auto-open after a Composer remount', async ({ page }) => {
  // Open the facet menu once via Shift+Tab, then close it.
  const badge = page.getByTestId('facet-badge');
  await expect(badge).toHaveText('Execute');
  await page.getByPlaceholder('Message pantoken…').focus();
  await page.keyboard.press('Shift+Tab');
  // No rotation — badge stays "Execute".
  await expect(badge).toHaveText('Execute');
  const panel = page.getByRole('listbox', { name: 'Facet' });
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Switch to a different session — this unmounts and remounts Composer,
  // resetting MenuBadge's local state. The greeting session's facet is
  // unchanged ("Execute") since Shift+Tab no longer rotates.
  await openSidebar(page);
  await page
    .getByTestId('sidebar')
    .locator('.row', { hasText: 'Explore the fold reducer' })
    .click();
  // Composer is remounted against the existing session.
  await expect(page.getByPlaceholder('Message pantoken…')).toBeVisible();

  // The facet menu must NOT have auto-popped on the remount.
  await expect(page.getByRole('listbox', { name: 'Facet' })).toHaveCount(0);

  // A fresh Shift+Tab still opens the menu (without rotating).
  await page.getByPlaceholder('Message pantoken…').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(badge).toHaveText('Execute');
  await expect(page.getByRole('listbox', { name: 'Facet' })).toBeVisible();
});

// Journey: the facet menu has no reload button — it was moved to Settings →
// Environment. Open the facet menu to confirm the absence, then open Settings to
// find and click the reload button there.
test('facet menu has no reload button; it lives in Settings → Environment', async ({ page }) => {
  // The reload button was moved out of the facet menu to Settings.
  const badge = page.getByTestId('facet-badge');
  await badge.click();
  const panel = page.getByRole('listbox', { name: 'Facet' });
  await expect(panel).toBeVisible();
  await expect(panel.getByTitle('Reload the facet list from disk')).toHaveCount(0);
  // Close the facet menu before opening Settings (the backdrop would intercept).
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  // Open Settings → Environment → find the reload button there.
  await openSettings(page, 'environment');
  const reload = page.getByTitle('Reload the facet list from disk');
  await expect(reload).toBeVisible();
  // Click it — the Settings panel stays open and no error appears.
  await reload.click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
});
