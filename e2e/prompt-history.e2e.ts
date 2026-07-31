import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

const composer = (page: Page) => page.locator(".composer-wrap textarea");

// ─── Ctrl+R prompt-history popup (merged from prompt-history-popup.e2e.ts) ────────

// The focused greeting session at boot has exactly one user message — recall surfaces it.
const GREETING = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// ArrowUp recalls the previous prompt, swaps work-in-progress drafts, and respects
// caret position in multi-line and soft-wrapped drafts before recalling
test("ArrowUp recalls prompts, swaps drafts, and respects caret position", async ({
  page,
}) => {
  const ta = composer(page);

  // --- Recall from an empty composer ---
  await expect(ta).toHaveValue("");
  await ta.focus();
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);

  // ArrowDown walks back past the newest entry to the (empty) live draft.
  await page.keyboard.press("ArrowDown");
  await expect(ta).toHaveValue("");

  // --- Swap a work-in-progress draft ---
  await ta.fill("a half-typed thought");
  // Caret sits at the end (single line = first AND last line), so ArrowUp recalls…
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);
  // …and ArrowDown brings back the exact work-in-progress text.
  await page.keyboard.press("ArrowDown");
  await expect(ta).toHaveValue("a half-typed thought");

  // --- ArrowUp moves the caret within a multi-line draft before recalling ---
  // Clear the recalled draft before testing caret-aware recall.
  await ta.fill("");
  // A real newline (Shift+Enter inserts one without sending).
  await ta.focus();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  // Caret is on the last line — ArrowUp should move it up a line, NOT recall history.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue("line one\nline two");
  // Now on the first line — a second ArrowUp recalls.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);

  // --- ArrowUp walks visual rows of a soft-wrapped line before recalling ---
  // One logical line (no newlines) long enough to soft-wrap into several visual rows.
  const wrapped = "wrap ".repeat(60).trim();
  await ta.fill(wrapped);
  // Caret at the end sits on the LAST visual row. Under logical-line gating this string is
  // first-AND-last line, so ArrowUp would recall immediately (the jank). Visual gating
  // moves the caret up a row instead — the draft must stay put.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(wrapped);
  // Jump to the very start (first visual row); now ArrowUp recalls.
  await ta.evaluate((el: HTMLTextAreaElement) => {
    el.selectionStart = el.selectionEnd = 0;
  });
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);
});

// Slash menu owns ArrowUp/ArrowDown; Alt+Enter inserts a newline instead of sending
test("slash menu owns arrow keys and Alt+Enter inserts a newline", async ({
  page,
}) => {
  const ta = composer(page);

  // --- History navigation does not hijack the slash-command menu arrows ---
  await ta.fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  // The slash menu owns ArrowUp/ArrowDown while open — the draft text stays "/".
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue("/");

  // --- Alt+Enter inserts a newline instead of sending ---
  // Clear the slash-command draft first.
  await ta.fill("");
  await ta.focus();
  await page.keyboard.type("line one");
  // Alt+Enter should insert a newline, not send (matching Shift+Enter behavior).
  await page.keyboard.press("Alt+Enter");
  await page.keyboard.type("line two");
  await expect(ta).toHaveValue("line one\nline two");
});

// A just-sent prompt is recallable from the now-empty composer
test("a just-sent prompt is recallable from the now-empty composer", async ({
  page,
}) => {
  const ta = composer(page);
  await ta.fill("send me then recall me");
  await page.keyboard.press("Enter");
  // The composer clears after sending.
  await expect(ta).toHaveValue("");

  // The just-sent prompt is the newest history entry.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue("send me then recall me");
  // The one before it is the seeded greeting prompt.
  await page.keyboard.press("ArrowUp");
  await expect(ta).toHaveValue(GREETING);
});

// Recall survives a reload (persisted submit log)
test("recall survives a reload (persisted submit log)", async ({ page }) => {
  const ta = composer(page);
  await ta.fill("durable across reload");
  await page.keyboard.press("Enter");
  await expect(ta).toHaveValue("");

  await page.reload();
  // The submit log is keyed by session id, which the reloaded store only knows
  // once the seed lands — wait for the transcript to be back (the just-sent
  // prompt row) before recalling, like a user who can see the page would.
  await expect(page.getByText("durable across reload").first()).toBeVisible();
  const reloaded = composer(page);
  await reloaded.focus();
  await page.keyboard.press("ArrowUp");
  await expect(reloaded).toHaveValue("durable across reload");
});

// Ctrl+R opens the prompt history popup and fills the composer on Enter
test("Ctrl+R opens prompt history popup and fills the composer on Enter", async ({
  page,
}) => {
  // Send a few prompts so there's history to recall.
  const popupComposer = page.getByPlaceholder("Message pantoken…");
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }

  // Focus the composer and press Ctrl+R.
  await popupComposer.focus();
  await popupComposer.press("Control+r");

  // The popup should be visible with recent prompts.
  const menu = page.getByTestId("prompt-history-menu");
  await expect(menu).toBeVisible();
  // At least one option (the exact count depends on how many unique prompts were sent).
  const optCount = await menu.getByRole("option").count();
  expect(optCount).toBeGreaterThan(0);

  // Arrow down to the next entry, Enter fills the composer.
  await menu.press("ArrowDown");
  await menu.press("Enter");
  await expect(menu).toHaveCount(0);
  // The composer should now have text (the selected prompt).
  await expect(popupComposer).not.toHaveValue("");
});

// Escape closes the prompt history popup without filling the composer
test("Escape closes the prompt history popup without filling", async ({
  page,
}) => {
  const popupComposer = page.getByPlaceholder("Message pantoken…");
  await drive(page, "reply");
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();

  await popupComposer.focus();
  await popupComposer.press("Control+r");
  const menu = page.getByTestId("prompt-history-menu");
  await expect(menu).toBeVisible();

  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
  // Composer should still be empty (no prompt was selected).
  await expect(popupComposer).toHaveValue("");
});
