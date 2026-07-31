import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // gotoFresh waits for the greeting's last text, but the greeting fires one more
  // runCompleted ~60ms later carrying the DEFAULT model config. These tests assert
  // config survives a switch, so let that trailing snapshot land first or it can
  // clobber the selection mid-test (the mock's only competing config source).
  await page.waitForTimeout(300);
});

// The combined badge shows both the model label and the effort level, and the
// old separate thinking badge no longer exists.
test("badge shows combined model + effort and no separate thinking badge", async ({
  page,
}) => {
  // AC.2 — one combined badge shows both model label and effort.
  const badge = page.getByTestId("model-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Claude Opus 4.8");
  await expect(badge).toContainText("medium");
  // The separate thinking badge no longer exists.
  await expect(page.getByTestId("thinking-badge")).toHaveCount(0);
});

// Opening the picker via the badge click lists models, switching one updates the
// badge and transcript, and every close path returns focus to the composer. Also
// verifies that clicking the badge focuses the filter input on desktop.
test("picker open via badge lists models, switches selection, and restores focus", async ({
  page,
}) => {
  // Issue #54 — closing the model picker by any path (here: click-open →
  // click-select) returns focus to the composer textarea.
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.click();
  await expect(composer).toBeFocused();

  const badge = page.getByTestId("model-badge");
  await badge.click();

  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  // AC.1 — opening the picker by clicking the badge (not via hotkey) focuses
  // the "Type to filter…" input, mirroring the hotkey-open behavior. The
  // desktop project runs at a viewport wider than 859px, so isPhone is false
  // and focus fires.
  await expect(panel.getByPlaceholder("Type to filter…")).toBeFocused();
  // AC.1 (re-asserted from the badge-focus test): opening via badge shows the panel.
  await expect(panel).toBeVisible();
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await panel.getByText("DeepSeek V4 Flash").click();

  // The badge reflects the switched-to model (server round-trip → folded config).
  await expect(page.getByTestId("model-badge")).toContainText(
    "DeepSeek V4 Flash",
  );
  // Info notice appears in the transcript.
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Model switched to deepseek/deepseek-v4-flash",
  );

  // Issue #54: every close path returns focus to the composer.
  await expect(composer).toBeFocused();
});

// The filter fuzzy-matches models and shows a no-match state for gibberish.
test("filter fuzzy-matches models and shows no-match state", async ({ page }) => {
  // AC.4 — typing in the filter fuzzy-matches models.
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  const filter = panel.getByPlaceholder("Type to filter…");

  await filter.fill("deep");
  await expect(panel.getByText("DeepSeek V4 Flash")).toBeVisible();
  await expect(panel.getByText("Claude Opus 4.8")).toHaveCount(0);
  await expect(panel.getByText("GPT-5")).toHaveCount(0);

  // no-match state
  await filter.fill("zzzz");
  await expect(panel.getByText("No models match")).toBeVisible();
});

// ⌘⇧M opens the picker and focuses the filter; the first Esc clears a populated
// filter (keeping the panel open) and a second Esc closes the panel and refocuses
// the composer. ⌘⇧E does nothing.
test("⌘⇧M hotkey opens picker; Esc clears then closes; ⌘⇧E is a no-op", async ({
  page,
}) => {
  // AC.3
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.click();
  await expect(composer).toBeFocused();

  await page.keyboard.press("Control+Shift+M");
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByPlaceholder("Type to filter…")).toBeFocused();

  // ⌘⇧E no longer opens anything.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await page.keyboard.press("Control+Shift+E");
  await expect(page.locator(".mp .panel")).toHaveCount(0);
});

// Selecting a new model stages its default effort level.
test("selecting a model stages its default effort", async ({ page }) => {
  // AC.5 — selecting a new model resets the staged effort to that model's default.
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");

  // Arrow down to Claude Sonnet 4.6 (second model in the list).
  await panel.getByPlaceholder("Type to filter…").press("ArrowDown");
  // The effort control should show "medium" (Sonnet's defaultThinkingLevel).
  const sonnetRow = panel
    .locator(".item")
    .filter({ hasText: "Claude Sonnet 4.6" });
  await expect(sonnetRow.locator(".eff-val")).toContainText("medium");
});

// The arrow keys cycle effort with clamping at both ends (no wrap).
test("←/→ and [/] cycle effort with clamping (no wrap)", async ({ page }) => {
  // AC.6
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");
  const filter = panel.getByPlaceholder("Type to filter…");

  // The active model (Opus) starts with effort "medium" (index 2 of [off, low, medium, high]).
  const opusRow = panel.locator(".item").filter({ hasText: "Claude Opus 4.8" });
  await expect(opusRow.locator(".eff-val")).toContainText("medium");

  // Arrow right → "high" (index 3, the last).
  await filter.press("ArrowRight");
  await expect(opusRow.locator(".eff-val")).toContainText("high");

  // Arrow right again — clamped at "high" (no wrap to "off").
  await filter.press("ArrowRight");
  await expect(opusRow.locator(".eff-val")).toContainText("high");

  // [ goes back to "medium".
  await filter.press("[");
  await expect(opusRow.locator(".eff-val")).toContainText("medium");

  // Arrow left → "low".
  await filter.press("ArrowLeft");
  await expect(opusRow.locator(".eff-val")).toContainText("low");

  // Arrow left to "off" then left again — clamped (no wrap to "high").
  await filter.press("ArrowLeft");
  await expect(opusRow.locator(".eff-val")).toContainText("off");
  await filter.press("ArrowLeft");
  await expect(opusRow.locator(".eff-val")).toContainText("off");
});

// Enter applies the combined model + effort in one action, and reopening the
// picker afterward highlights the now-active model (preselect) so its effort
// can be cycled immediately.
test("Enter applies combined model + effort and picker preselects the active model", async ({
  page,
}) => {
  // AC.7 — Enter sends one combined setModel action with both modelId and thinkingLevel.
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");
  const filter = panel.getByPlaceholder("Type to filter…");

  // Arrow down to Sonnet, then arrow right to cycle effort to "high".
  await filter.press("ArrowDown");
  await filter.press("ArrowRight");
  await filter.press("ArrowRight");

  // Enter applies.
  await filter.press("Enter");

  // The badge reflects the new model + effort.
  await expect(page.getByTestId("model-badge")).toContainText(
    "Claude Sonnet 4.6",
  );
  await expect(page.getByTestId("model-badge")).toContainText("high");
  // Info notice appears in the transcript with both model and thinking level.
  await expect(page.locator(".row.notice .ntext")).toContainText(
    "Model switched to anthropic/claude-sonnet-4-6 (thinking: high)",
  );

  // Issue #82 — the picker must highlight the current model on open, not the
  // first in the list, so the user can immediately cycle its effort level.
  // First confirm the switch took (badge re-asserted from the preselect test).
  await expect(page.getByTestId("model-badge")).toContainText(
    "Claude Sonnet 4.6",
  );
  // Reopen — the active model (Sonnet) should be highlighted, not Opus.
  await page.getByTestId("model-badge").click();
  const hlRow = page.locator(".mp .panel .item.hl");
  await expect(hlRow).toContainText("Claude Sonnet 4.6");

  // Arrow right cycles the highlighted (active) model's effort from
  // "medium" (Sonnet's default, index 2 of [off, low, medium, high]) to "high".
  await page
    .locator(".mp .panel")
    .getByPlaceholder("Type to filter…")
    .press("ArrowRight");
  await expect(hlRow.locator(".eff-val")).toContainText("high");
});

// First Esc clears a populated filter (panel stays open), second Esc closes the
// panel and refocuses the composer.
test("first Esc clears the filter; second Esc closes and refocuses", async ({
  page,
}) => {
  // AC.9
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.click();

  await page.keyboard.press("Control+Shift+M");
  const panel = page.locator(".mp .panel");
  const filter = panel.getByPlaceholder("Type to filter…");

  await filter.fill("deep");
  await expect(filter).toHaveValue("deep");

  // First Esc clears the query — panel stays open.
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(panel).toBeVisible();

  // Second Esc closes the panel and returns focus to the composer.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(composer).toBeFocused();
});

// Models with a single "off" effort level show a "select" button instead of the
// cycle control, and clicking it applies the model directly.
test("no-effort models show a select button instead of the effort control", async ({
  page,
}) => {
  // AC.10 — DeepSeek V4 Flash has a single "off" level, so it shows "select".
  await page.getByTestId("model-badge").click();
  const panel = page.locator(".mp .panel");

  // DeepSeek Flash row should have a "select" button (single level → no cycle control).
  const flashRow = panel
    .locator(".item")
    .filter({ hasText: "DeepSeek V4 Flash" });
  await expect(flashRow.locator(".select-btn")).toBeVisible();

  // Clicking it applies the model directly.
  await flashRow.locator(".select-btn").click();
  await expect(page.getByTestId("model-badge")).toContainText(
    "DeepSeek V4 Flash",
  );
});

// Regression: opening the model picker via ⌘⇧M and closing it, then switching
// sessions (which unmounts + remounts Composer via App.svelte's {#if} block),
// must NOT auto-pop the picker. Root cause: ModelPicker's lastHotkeyN was
// reset to 0 on remount while store.hotkeyAction (monotonic, never reset)
// still held a prior {n:1}, so the effect re-fired toggle(true). Fixed by
// initializing lastHotkeyN to the current store value at mount (mirrors
// Transcript's lastSendN = store.promptSentN).
test("the model picker does not auto-open after a Composer remount", async ({
  page,
}) => {
  // Open the picker once via hotkey, then close it.
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.click();
  await expect(composer).toBeFocused();
  await page.keyboard.press("Control+Shift+M");
  const panel = page.locator(".mp .panel");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Switch to a different session — this unmounts and remounts Composer,
  // resetting ModelPicker's local state.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .locator(".row", { hasText: "Wire up the WebSocket bridge" })
    .click();
  // Composer is remounted against the existing session.
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();

  // The model picker must NOT have auto-popped on the remount.
  await expect(page.locator(".mp .panel")).toHaveCount(0);

  // A fresh ⌘⇧M still opens the picker and focuses the filter, proving the
  // hotkey path works after a remount.
  await page.getByPlaceholder("Message pantoken…").click();
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".mp .panel")).toBeVisible();
  await expect(
    page.locator(".mp .panel").getByPlaceholder("Type to filter…"),
  ).toBeFocused();
});
