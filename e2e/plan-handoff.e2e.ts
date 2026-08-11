import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

function actionNames(dialog: import("@playwright/test").Locator) {
  return dialog.locator(".actions button").allTextContents();
}

async function expectRefusalWire(
  page: import("@playwright/test").Page,
  value: string,
  feedback: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const messages = await page.locator(".row.notice .ntext").allTextContents();
      const message = [...messages].reverse().find((text) => text.includes("respondUi: "));
      if (!message) return null;
      try {
        const payload = JSON.parse(message.slice(message.indexOf("respondUi: ") + "respondUi: ".length));
        return { value: payload.value, feedback: payload.decision?.refuse?.feedback };
      } catch {
        return null;
      }
    })
    .toEqual({ value, feedback });
}

// The visible refusal action is stable and never exposes daemon labels or hints.
test("plan-handoff preserves action ordering and stable refusal affordance", async ({ page }) => {
  await drive(page, "planhandoff");
  let dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("plan.md")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Plan: Add facet indicator + plan-handoff card" })).toBeVisible();
  await expect(dialog.locator(".plan-body")).toBeVisible();
  await expect.poll(() => actionNames(dialog)).toEqual([
    "Refuse", "Implement (current context)", "Implement (new context)",
  ]);
  await expect(dialog.getByRole("button", { name: "Refuse", exact: true })).toHaveAttribute("title", /Escape/);
  await expect(dialog.getByRole("button", { name: /Daemon refuse option|Tab for feedback/ })).toHaveCount(0);

  const refuse = dialog.getByRole("button", { name: "Refuse", exact: true });
  await refuse.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /feedback/i })).toBeFocused();
  await expect(refuse).toHaveText("Refuse");
  await expect(refuse).toHaveAttribute("aria-label", "Refuse");
  await expect(refuse).toHaveAttribute("title", /again/);
  await refuse.click();
  await expect(dialog).toBeHidden();

  await drive(page, "planhandoff");
  dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Implement (new context)", exact: true }).click();
  await expect(page.getByText("Received: Implement (new context)")).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("plan-handoff minimize button collapses and restores the approval", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: /minimize to pill/i }).click();
  await expect(dialog).toBeHidden();
  const pill = page.locator(".attention-pill");
  await expect(pill).toBeVisible();

  await pill.click();
  await expect(dialog).toBeVisible();
  await expect(pill).toBeHidden();
});

test("plan-handoff refusal editor survives desktop minimize and restore", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  const field = dialog.getByRole("textbox", { name: /feedback/i });
  await field.fill("Keep this plan focused.");

  await dialog.getByRole("button", { name: /minimize to pill/i }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".attention-pill")).toBeVisible();

  await page.locator(".attention-pill").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /feedback/i })).toHaveValue(
    "Keep this plan focused.",
  );
});

// Journey: normal plan-handoff resolution and cancellation paths. Each request is
// resolved before the next drive so the dev-bar fixture controls remain usable.
test("plan-handoff resolves and cancels successive requests", async ({ page }) => {
  await drive(page, "planhandoff");
  const implementation = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(implementation).toBeVisible();
  await implementation
    .getByRole("button", { name: "Implement (new context)", exact: true })
    .click();
  await expect(page.getByText("Received: Implement (new context)")).toBeVisible();
  await expect(implementation).toBeHidden();

  await drive(page, "planhandoff");
  const refusal = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(refusal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(refusal.getByRole("textbox", { name: /feedback/i })).toBeFocused();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-labelledby="approval-title"]');
        return Boolean(dialog && !dialog.contains(document.activeElement));
      }),
    )
    .toBe(true);
  await page.locator(".scrim").click({ position: { x: 3, y: 3 } });
  await expect(refusal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(refusal).toBeHidden();
  await expect(page.getByText(/Plan refusal submitted without feedback/)).toBeVisible();
});

test("plan-handoff submits typed refusal and empty feedback", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await dialog.getByRole("textbox", { name: /feedback/i }).fill("Please split this into smaller steps.");
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await expect(dialog).toBeHidden();
  // The acknowledgement renders as a transcript notice row (exactly one).
  await expect(
    page
      .locator(".row.notice .ntext")
      .filter({ hasText: "Plan refusal submitted with feedback." }),
  ).toHaveCount(1);
  await expectRefusalWire(page, "Daemon refuse option (Tab for feedback)", "Please split this into smaller steps.");

  await drive(page, "planhandoff");
  const emptyDialog = page.getByRole("dialog", { name: "Plan handoff" });
  await emptyDialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await emptyDialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await expect(emptyDialog).toBeHidden();
  await expect(
    page
      .locator(".row.notice .ntext")
      .filter({ hasText: "Plan refusal submitted without feedback." }),
  ).toHaveCount(1);
  await expectRefusalWire(page, "Daemon refuse option (Tab for feedback)", "");
});

test("plan-handoff Escape uses the two-step refusal flow and implementation remains immediate", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /feedback/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Plan refusal submitted without feedback/)).toBeVisible();

  await drive(page, "planhandoff");
  const implementation = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(implementation).toBeVisible();
  await implementation.getByRole("button", { name: "Implement (new context)", exact: true }).click();
  await expect(page.getByText("Received: Implement (new context)")).toBeVisible();
});

test("plan-handoff scrim protects revealed feedback and untouched plan behavior", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  const field = dialog.getByRole("textbox", { name: /feedback/i });
  await expect(field).toHaveValue("");
  await page.locator(".scrim").click({ position: { x: 3, y: 3 } });
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("");
  await field.fill("Keep this draft.");
  await page.locator(".scrim").click({ position: { x: 3, y: 3 } });
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("Keep this draft.");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

// The document-level Escape handler must not steal Escape from an open
// PlanView overlay: Escape closes ONLY the overlay, leaving the pending
// approval untouched (deny-safe cancellation still belongs to the sheet).
test("plan-handoff Escape closes only the plan-view overlay over a pending approval", async ({
  page,
}) => {
  // Drive the planview fixture BEFORE the approval dialog opens: the approval
  // scrim covers the dev bar, so the second drive would be unclickable.
  await drive(page, "planview");
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();

  // Open the plan-view overlay while the approval is still pending. ⌘P (not the
  // header button) so the click cannot be intercepted by the approval scrim.
  await page.keyboard.press("Meta+p");
  const modal = page.getByTestId("plan-view");
  await expect(modal).toBeVisible();
  // Meta+P does not move focus into PlanView. This assertion intentionally proves
  // the target-level approval handler is still first in the next Escape dispatch.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-labelledby="approval-title"]');
        return Boolean(dialog && dialog.contains(document.activeElement));
      }),
    )
    .toBe(true);

  // Escape closes only the overlay — the approval dialog stays open.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // First Escape after the overlay reveals feedback; the second submits refusal.
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("textbox", { name: /feedback/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("plan-handoff Escape cancels after the rendered PlanView disappears on active-plan transition", async ({
  page,
}) => {
  // Seed the plan text before opening the pending handoff; the approval scrim hides
  // the dev bar, so the facet transition is invoked through the mock hook.
  await drive(page, "planview");
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toBeVisible();

  await page.evaluate(() => {
    const mock = (window as unknown as { __pantokenMock?: (script: string) => void })
      .__pantokenMock;
    if (!mock) throw new Error("mock hook unavailable");
    mock("planfacet");
  });
  await expect(page.getByTestId("plan-view")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // The stale toggle must not swallow the first Escape after the rendered panel disappears.
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("textbox", { name: /feedback/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("plan-handoff Meta/Ctrl+Enter submits revealed refusal and never implementation", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await dialog.getByRole("textbox", { name: /feedback/i }).fill("Keyboard refusal.");
  await page.keyboard.press("Meta+Enter");
  await expect(dialog).toBeHidden();
  await expect(
    page
      .locator(".row.notice .ntext")
      .filter({ hasText: "Plan refusal submitted with feedback." }),
  ).toHaveCount(1);
  await expect(page.getByText("Received: Implement (new context)")).toHaveCount(0);
});

test("plan_handoff_refusal_label_equals_cancel_label", async ({ page }) => {
  await drive(page, "planhandofflegacy");
  const legacy = page.getByRole("dialog", { name: "Plan handoff (legacy daemon)" });
  await expect.poll(() => actionNames(legacy)).toEqual([
    "Refuse", "Implement (current context)", "Implement (new context)",
  ]);
  await page.keyboard.press("Escape");
  await expect(legacy.getByRole("textbox", { name: /feedback/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(legacy).toBeHidden();

  // Older daemons omit the refusal label, so the stable Refuse affordance uses
  // the legacy third action value on the wire.
  await drive(page, "planhandofflegacy");
  const legacyFeedback = page.getByRole("dialog", { name: "Plan handoff (legacy daemon)" });
  await legacyFeedback.getByRole("button", { name: "Refuse", exact: true }).click();
  await legacyFeedback.getByRole("textbox", { name: /feedback/i }).fill("Legacy daemon feedback.");
  await legacyFeedback.getByRole("button", { name: "Refuse", exact: true }).click();
  await expect(legacyFeedback).toBeHidden();
  await expect(
    page
      .locator(".row.notice .ntext")
      .filter({ hasText: "Plan refusal submitted with feedback." }),
  ).toHaveCount(1);
  await expect(page.getByText(/respondUi:.*Cancel.*Legacy daemon feedback\./)).toBeVisible();

  await drive(page, "planhandoffequal");
  const equal = page.getByRole("dialog", { name: "Plan handoff (equal labels)" });
  await expect(equal.getByRole("button", { name: "Refuse", exact: true })).toHaveCount(1);
  await equal.getByRole("button", { name: "Refuse", exact: true }).click();
  const equalFeedback = equal.getByRole("textbox", { name: /feedback/i });
  await expect(equalFeedback).toBeFocused();
  await equalFeedback.fill("Keep the equal-label draft.");
  // A revealed editor protects the dialog from scrim dismissal and preserves its draft.
  await page.locator(".scrim").click({ position: { x: 3, y: 3 } });
  await expect(equal).toBeVisible();
  await expect(equalFeedback).toHaveValue("Keep the equal-label draft.");
  // Escape submits the revealed refusal, preserving the draft as feedback.
  await page.keyboard.press("Escape");
  await expect(equal).toBeHidden();
  await expect(page.getByText(/Plan refusal submitted with feedback/)).toHaveCount(2);

  // A fresh equal-label request still times out through generic cancellation, never
  // submitting the revealed refusal (or its draft) as a plan answer.
  await drive(page, "planhandoffequal");
  const timedEqual = page.getByRole("dialog", { name: "Plan handoff (equal labels)" });
  await timedEqual.getByRole("button", { name: "Refuse", exact: true }).click();
  await timedEqual.getByRole("textbox", { name: /feedback/i }).fill("equal timeout sentinel");
  await expect(timedEqual).toBeHidden({ timeout: 8000 });
  // The timed equal-label request still uses generic cancellation.
  await expect(
    page.locator(".row.notice .ntext").filter({ hasText: "Dialog cancelled." }),
  ).toHaveCount(1);
  // The timed equal request's own response summary is a generic cancellation
  // (all three cancellations render now that replayed request ids are unique).
  await expect(
    page
      .locator(".row.notice .ntext")
      .filter({ hasText: /respondUi:.*cancelled.*true/ })
      .last(),
  ).toBeVisible();
  await expect(page.getByText(/equal timeout sentinel/)).toHaveCount(0);
  // The timed equal request must not have added a refusal beyond the legacy and
  // equal-label refusal journeys above.
  await expect(
    page.locator(".row.notice .ntext").filter({ hasText: "Plan refusal submitted" }),
  ).toHaveCount(3);

  await drive(page, "planhandoffcollision");
  const collision = page.getByRole("dialog", { name: "Plan handoff (collision)" });
  await expect.poll(() => actionNames(collision)).toEqual([
    "Refuse", "Implement (current context)", "Implement (new context)",
  ]);
  await expect(collision.getByRole("button", { name: "Refuse", exact: true })).toBeDisabled();
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("Escape");
  await expect(collision).toBeHidden();
  await expect(page.getByText(/respondUi:.*Implement \(current context\)/)).toHaveCount(0);
});

test("plan-handoff renders markdown and preserves plan-body scrolling", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  const body = dialog.locator(".plan-body");
  await expect(dialog.getByRole("heading", { name: "Plan: Add facet indicator + plan-handoff card" })).toBeVisible();
  await expect.poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("plan-handoff drafted timeout resolves to generic cancellation without refusal", async ({ page }) => {
  await drive(page, "planhandofftimeout");
  const dialog = page.getByRole("dialog", { name: "Plan handoff (timed)" });
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await dialog.getByRole("textbox", { name: /feedback/i }).fill("timeout sentinel");
  await expect(dialog).toBeHidden({ timeout: 8000 });
  await expect(
    page.locator(".row.notice .ntext").filter({ hasText: "Dialog cancelled." }),
  ).toHaveCount(1);
  await expect(page.getByText(/respondUi:.*cancelled.*true/)).toBeVisible();
  await expect(page.getByText(/timeout sentinel/)).toHaveCount(0);
  await expect(page.getByText(/Plan refusal submitted/)).toHaveCount(0);
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

// A timed-out plan card always uses generic cancellation, never a refusal or
// typed legacy Cancel value, even after feedback was drafted.
test("a timed-out drafted plan card auto-resolves to generic cancellation", async ({ page }) => {
  await drive(page, "planhandofftimeout");
  const dialog = page.getByRole("dialog", { name: "Plan handoff (timed)" });
  await expect(page.getByText(/Auto-dismiss in \d+s/)).toBeVisible();
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await dialog.getByRole("textbox", { name: /feedback/i }).fill("timeout sentinel");
  await expect(dialog).toBeHidden({ timeout: 8000 });
  await expect(
    page.locator(".row.notice .ntext").filter({ hasText: "Dialog cancelled." }),
  ).toHaveCount(1);
  await expect(page.getByText(/respondUi:.*cancelled.*true/)).toBeVisible();
  await expect(page.getByText(/Received: Cancel/)).toHaveCount(0);
  await expect(page.getByText(/timeout sentinel/)).toHaveCount(0);
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
