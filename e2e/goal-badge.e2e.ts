import { expect, test } from '@playwright/test';
import { drive, gotoFresh } from './helpers.js';

// Goal flows: the GoalBadge (StatusHeader subtitle showing the active saved-session
// goal summary + lifecycle) and the goal-proposal blocking dialog (Allow / Escape /
// unknown-type error card). The badge is display-only (driven by a snapshot carrying
// `goal` → foldEvent → state.goal → GoalBadge). The proposal dialog is an
// interrogative that blocks until the user resolves it.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: the goal badge appears in the StatusHeader subtitle when a goal is
// active (summary + lifecycle tooltip), then hides when the goal is cleared.
test('the goal badge renders with summary and tooltip, then hides when cleared', async ({ page }) => {
  // Before driving goalactive: no goal → no badge.
  await expect(page.getByTestId('goal-badge')).toHaveCount(0);

  // Drive the goalactive fixture → a snapshot with goal lands.
  await drive(page, 'goalactive');

  // The badge appears in the StatusHeader subtitle with the summary.
  const badge = page.getByTestId('goal-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Ship the goal badge feature');

  // The tooltip carries the full summary + lifecycle state.
  await expect(badge).toHaveAttribute(
    'title',
    'Goal: Ship the goal badge feature (active)',
  );

  // Re-drive goalactive (badge already showing) then clear the goal — verifies
  // the badge persists across a re-snapshot and hides on goal:null.
  await drive(page, 'goalactive');
  await expect(badge).toBeVisible();

  // Drive goalclear → a snapshot with goal:null clears state.goal → badge hides.
  await drive(page, 'goalclear');
  await expect(badge).toHaveCount(0);
});

// Journey: goal proposal requests are independently resolved on one boot.
test('goal card: inspect, Allow, and Escape journeys', async ({ page }) => {
  await drive(page, 'goal');
  let dialog = page.getByRole('dialog', { name: 'Ship feature X' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Implement the new dashboard widget')).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(
    page.locator('.row.notice .ntext').filter({ hasText: 'Dialog cancelled.' }).last(),
  ).toBeVisible();

  await drive(page, 'goal');
  dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Approved — continuing.')).toBeVisible();

  await drive(page, 'goal');
  dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(
    page.locator('.row.notice .ntext').filter({ hasText: 'Dialog cancelled.' }).last(),
  ).toBeVisible();
});

// Journey: an unknown interrogative type renders an error card with a single
// Dismiss button (no Deny/Allow pair — both would silently cancel).
test('unknown interrogative type renders an error card with Dismiss', async ({ page }) => {
  await drive(page, 'unknown');
  const dialog = page.getByRole('dialog', {
    name: '⚠ Unknown request type: some_future_type',
  });
  await expect(dialog).toBeVisible();
  // The dialog is blocking.
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Exactly one action button — no Deny/Allow pair (both would silently cancel).
  // Scoped to .actions so the always-present "Minimize" chrome button isn't counted.
  const actions = dialog.locator('.actions');
  const buttons = actions.getByRole('button');
  await expect(buttons).toHaveCount(1);
  // Dismiss produces {cancelled:true} → Cancel via the reverse builder's Unknown arm.
  await actions.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('.row.notice .ntext').filter({ hasText: 'Dialog cancelled.' }).last(),
  ).toBeVisible();
});
