import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: the composer status row shows a ring-only context trigger
test("the composer status row shows a ring-only context trigger", async ({ page }) => {
  const ring = page.getByTestId("context-meter");
  const trigger = page.getByTestId("context-trigger");
  await expect(ring).toBeVisible();
  // The inline trigger is intentionally quiet; exact usage remains in its popup.
  await expect(ring).not.toHaveText(/%/);
  await expect(trigger).toHaveAttribute("aria-label", /Context window/);
  await expect(trigger).toHaveAttribute("title", /exact context window usage/);
});

// Journey: a context-pressure cue surfaces once the window is nearly full
test("a context-pressure cue surfaces once the window is nearly full", async ({
  page,
}) => {
  const cue = page.getByTestId("context-cue");
  // Baseline MOCK_USAGE is 24% — well under the ≥85% threshold, so no cue.
  await expect(cue).toHaveCount(0);

  // `contextfull` pushes the focused session to 91% (danger band).
  await drive(page, "contextfull");

  await expect(cue).toBeVisible();
  await expect(cue).toContainText("Context 91% full");
  await expect(cue).toContainText("/compact");
  // Tone tracks the meter ring: 90%+ is the danger band.
  await expect(cue).toHaveClass(/danger/);
  // The ring remains text-free; the trigger label carries the current band for assistive tech.
  await expect(page.getByTestId("context-trigger")).toHaveAttribute("aria-label", /91% used/);
});

test("an over-window usage renders 100% — never 200% — while the popup keeps raw counts", async ({
  page,
}) => {
  // `contextover` pushes the mock's usage to tokens 400_000 / window 200_000
  // (percent 200.0). The mock constructs SessionUsage directly and bypasses the
  // server's usage_from_state clamp, so this exercises the client-side
  // clampContextPercent path end-to-end.
  await drive(page, "contextover");

  const cue = page.getByTestId("context-cue");
  await expect(cue).toBeVisible();
  await expect(cue).toContainText("Context 100% full");

  const trigger = page.getByTestId("context-trigger");
  await expect(trigger).toHaveAttribute("aria-label", "Context window: 100% used");

  // The raw truth stays visible: the popup keeps the unclamped token counts.
  await page.getByTestId("context-meter").click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toContainText("400,000 / 200,000 tokens");
  await expect(popup).toContainText("100% of window");
});

// Journey: the model and effort pickers live beside the context ring
test("the model and effort pickers live beside the context ring", async ({
  page,
}) => {
  const right = page.getByTestId("composer-status-right");
  await expect(right.getByTestId("model-badge")).toContainText("Claude Opus 4.8");
  await expect(right.getByTestId("model-badge")).toContainText("medium");
  await expect(right.getByTestId("context-trigger")).toBeVisible();
  await expect(page.locator(".hdr .mp")).toHaveCount(0);
});

// Journey: the context meter popup shows detail on click
test("the context meter popup shows detail on click", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await expect(meter).toBeVisible();
  // Click the meter to pin the popup open.
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(/tokens/);
  await expect(popup).toContainText(/of window/);
  // The popup has Compact + Clear context action buttons.
  await expect(page.getByTestId("compact-btn")).toBeVisible();
  await expect(page.getByTestId("clear-context-btn")).toBeVisible();
});

// Journey: the Compact button uses a click-twice confirm gate
test("the Compact button uses a click-twice confirm gate", async ({ page }) => {
  await drive(page, "contextfull");
  const meter = page.getByTestId("context-meter");
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  const compactBtn = page.getByTestId("compact-btn");
  // First click arms.
  await compactBtn.click();
  await expect(compactBtn).toHaveText("Click again");
  // Second click fires.
  await compactBtn.click();
  // The mock emits a usageUpdated — the accessible trigger drops to 4%.
  await expect(page.getByTestId("context-trigger")).toHaveAttribute("aria-label", /4% used/);
});
