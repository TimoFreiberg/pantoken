import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Plan-handoff card: renders the plan markdown + the 3 daemon-supplied action
// buttons.
test("plan-handoff card renders the plan markdown and 3 action buttons", async ({
  page,
}) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();

  // The plan doc's friendly path is shown so the operator knows what they're approving.
  await expect(dialog.getByText("plan.md")).toBeVisible();

  // The plan markdown body renders — a heading from the planText is visible, and the
  // scrollable container is present.
  await expect(dialog.getByRole("heading", { name: "Plan: Add facet indicator + plan-handoff card" })).toBeVisible();
  await expect(dialog.locator(".plan-body")).toBeVisible();

  // The 3 action buttons carry the daemon's action_labels (not hardcoded strings),
  // in PlanHandoffDecision order.
  for (const label of [
    "Implement (new context)",
    "Implement (current context)",
    "Cancel",
  ]) {
    await expect(
      dialog.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }
});

// Clicking Implement (new context) resolves the plan-handoff card.
test("clicking Implement (new context) resolves the plan-handoff card", async ({
  page,
}) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();

  await dialog
    .getByRole("button", { name: "Implement (new context)", exact: true })
    .click();
  // The mock acks a value response with "Received: <value>".
  await expect(page.getByText("Received: Implement (new context)")).toBeVisible();
  await expect(dialog).toBeHidden();
});

// Escape cancels the plan-handoff card (deny-safe).
test("Escape cancels the plan-handoff card (deny-safe)", async ({ page }) => {
  await drive(page, "planhandoff");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

// ⌘/Ctrl+Enter submits the primary action (Implement, new context).
test("⌘/Ctrl+Enter submits the primary action (Implement, new context)", async ({
  page,
}) => {
  await drive(page, "planhandoff");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("Received: Implement (new context)")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
});

// Plan-handoff Cancel: click-twice confirm gate arms and fires the cancel, and
// Esc disarms when armed without cancelling.
test("plan-handoff Cancel: click-twice gate fires, and Esc disarms when armed", async ({
  page,
}) => {
  test.setTimeout(60000);

  // ── Cancel uses a click-twice confirm gate ────────────────────────────
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog");

  // ── AC.2: first click arms, does not dismiss ──────────────────
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Click again" })).toBeVisible();
  // Dialog is still visible (not dismissed).
  await expect(dialog).toBeVisible();

  // ── AC.6: armed button carries the .armed class + danger color ─
  const armedBtn = dialog.getByRole("button", { name: "Click again" });
  await expect(armedBtn).toHaveClass(/\bbtn\b.*\barmed\b/);
  const dangerColor = await page.evaluate(() => {
    const el = document.querySelector(".sheet.plan .actions .btn.armed") as HTMLElement | null;
    return el ? getComputedStyle(el).color : null;
  });
  expect(dangerColor).not.toBeNull();
  expect(dangerColor).toMatch(/rgb|rgba|hsl|hsla/);

  // Second click fires the cancel — mock acks as "Received: Cancel".
  await armedBtn.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Received: Cancel")).toBeVisible();

  // ── Esc disarms when armed without cancelling ──────────────────────────
  await drive(page, "planhandoff");
  const disarmDialog = page.getByRole("dialog");

  // Arm the cancel gate.
  await disarmDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(disarmDialog.getByRole("button", { name: "Click again" })).toBeVisible();

  // AC.4: Esc while armed disarms (label reverts) without cancelling.
  await page.keyboard.press("Escape");
  await expect(disarmDialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  // The dialog is still visible (Esc did NOT cancel).
  await expect(disarmDialog).toBeVisible();
});

// Facet badge shows 'Plan' when the active facet is plan, then reverts to Execute.
test("facet badge shows Plan when the active facet is plan", async ({
  page,
}) => {
  await drive(page, "planfacet");
  // The badge shows the actual facet "Plan" (accent-tinted) while the snapshot
  // carries facet:"plan".
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Plan");
  await expect(badge).toHaveAttribute("title", /⇧Tab/);
  // After the dwell, the script reverts to facet:"execute" and the badge returns
  // to its subtle "Execute" chip (always visible — a state readout, not a toggle
  // that hides).
  await expect(badge).toHaveText("Execute");
});

// A timed-out plan card auto-dismisses to the cancel decision (deny-safe).
test("a timed-out plan card auto-dismisses to the cancel decision", async ({
  page,
}) => {
  // The deny-safe autoResolve path for a `plan` kind must send the Cancel label
  // (a typed plan_handoff_answer), not the universal {cancelled} — matching the
  // visible Cancel button's wire shape (the C1 fix).
  await drive(page, "planhandofftimeout");
  await expect(page.getByText(/Auto-dismiss in \d+s/)).toBeVisible();
  // After the timeout it auto-resolves to the deny-safe default (the cancel label).
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 8000 });
  await expect(page.getByText("Received: Cancel")).toBeVisible();
});

// Plan sheet width matches the transcript text column.
test("plan sheet width matches the transcript text column", async ({ page }) => {
  // The plan sheet is capped at var(--maxw) + 42px of chrome (20px padding × 2 +
  // 1px border × 2) so the plan text inside is exactly as wide as the transcript
  // column. The calc(100% - 48px) cap only kicks in when .chat is narrow, so
  // both sidebars must be closed to make .chat full-width (1100px at the desktop
  // viewport) and exercise the reading-measure branch.
  const leftSidebar = page.getByTestId("sidebar");
  const rightSidebar = page.getByTestId("right-sidebar");

  // Close both sidebars via their toggle shortcuts. These are toggles, so assert
  // the closed state afterward — a prior test could have left one closed, making
  // the toggle re-open it. Asserting turns a silent wrong-state into a failure.
  await page.keyboard.press("Meta+b");
  await expect(leftSidebar).toHaveAttribute("data-open", "false");
  await page.keyboard.press("Meta+Shift+j");
  await expect(rightSidebar).toHaveAttribute("data-open", "false");

  await drive(page, "planhandoff");
  const sheet = page.locator(".sheet.plan");
  await expect(sheet).toBeVisible();

  const { maxw, chatWidth, sheetWidth } = await sheet.evaluate((el) => {
    const chat = el.closest(".chat") as HTMLElement | null;
    const chatStyle = chat ? getComputedStyle(chat) : null;
    const maxw = chatStyle
      ? parseFloat(chatStyle.getPropertyValue("--maxw"))
      : NaN;
    const sheetRect = (el as HTMLElement).getBoundingClientRect();
    const chatRect = chat ? chat.getBoundingClientRect() : { width: NaN };
    return {
      maxw,
      chatWidth: chatRect.width,
      sheetWidth: sheetRect.width,
    };
  });

  // --maxw is 760px; sheet width should be --maxw + 42px = 802px (±3px for
  // border/rounding), so the text content inside matches the transcript column.
  const expected = maxw + 42;
  expect(Math.abs(sheetWidth - expected)).toBeLessThanOrEqual(3);
  // The scrim gutter is visible on both sides — sheet is narrower than .chat.
  expect(sheetWidth).toBeLessThan(chatWidth);
});

// Plan-view overlay: the plan button appears, opens the modal, Escape closes it,
// and ⌘P toggles the overlay.
test("plan-view overlay: button appears, opens modal, Escape closes, ⌘P toggles", async ({
  page,
}) => {
  // The PlanView overlay surfaces the daemon's active_plan (the plan facet's
  // structured plan document) as a modal rendering of the plan markdown. Triggered
  // by a StatusHeader button that appears only when activePlan is non-empty.

  // Before driving `planview`: no activePlan → no Plan button.
  await expect(page.getByTestId("plan-view-toggle")).toHaveCount(0);

  // Drive the planview fixture → a snapshot with activePlan lands.
  await drive(page, "planview");

  // The Plan button appears in the StatusHeader.
  const planBtn = page.getByTestId("plan-view-toggle");
  await expect(planBtn).toBeVisible();

  // Click it → the PlanView modal opens with the plan markdown rendered.
  await planBtn.click();
  const modal = page.getByTestId("plan-view");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Wire up the plan overlay");

  // Escape closes the modal.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // ── ⌘P toggles the plan view overlay ───────────────────────────────────
  await drive(page, "planview");
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();

  // ⌘P opens the overlay.
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toBeVisible();

  // ⌘P again closes it.
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toHaveCount(0);
});

// Plan-view overlay: the chooser hides the plan button and makes ⌘P inert, then
// the full plan markdown renders in the modal.
test("plan-view overlay: chooser hides button, then full markdown renders", async ({
  page,
}) => {
  test.setTimeout(60000);

  // ── The chooser hides the plan button and makes ⌘P inert ───────────────
  await drive(page, "planview");
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();

  // In the chooser view the Plan button must hide and ⌘P must not flip its state.
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  await expect(page.getByTestId("plan-view-toggle")).toHaveCount(0);

  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toHaveCount(0);

  // Returning to the session restores the button (state wasn't corrupted).
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .locator(".row", { hasText: "Wire up the WebSocket bridge" })
    .click();
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();

  // ── The overlay renders the full plan markdown ─────────────────────────
  await drive(page, "planview");
  await page.getByTestId("plan-view-toggle").click();
  const modal = page.getByTestId("plan-view");
  await expect(modal).toBeVisible();

  // The plan's heading + body render (the Markdown.svelte path).
  const body = page.getByTestId("plan-view-body");
  await expect(body).toContainText("Wire up the plan overlay");
  await expect(body).toContainText("SessionSnapshot protocol");
  await expect(body).toContainText("event-map");
  await expect(body).toContainText("read-only");

  // Escape closes.
  // Click the modal body first to ensure focus is inside the overlay (the
  // chooser section's sidebar interactions can leave focus elsewhere).
  await modal.click();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

// Adventurous-handoff: toggling in the open menu does not send a request until
// commit (Enter flushes exactly one new notice).
test("adventurous-handoff: toggle does not send a request until commit", async ({
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

// Adventurous-handoff: aborting the menu discards the pending handoff change.
test("adventurous-handoff: aborting the menu discards the pending change", async ({
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
