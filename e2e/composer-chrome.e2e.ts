import { expect, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("2a composer chrome keeps the box and status landmarks in place", async ({ page }) => {
  const box = page.getByTestId("composer-box");
  const facetSlot = page.getByTestId("composer-facet-slot");
  const attachments = page.getByTestId("composer-attachments");
  const status = page.getByTestId("composer-status-row");
  const right = page.getByTestId("composer-status-right");

  await expect(box).toBeVisible();
  await expect(facetSlot.getByTestId("facet-badge")).toBeVisible();
  await expect(attachments.getByRole("button", { name: "Attach images" })).toBeVisible();
  await expect(status.getByTestId("permission-badge")).toBeVisible();
  await expect(right.getByTestId("model-badge")).toBeVisible();
  await expect(right.getByTestId("thinking-badge")).toBeVisible();
  await expect(right.getByTestId("context-trigger")).toBeVisible();

  const boxRect = await box.boundingBox();
  const facetRect = await facetSlot.boundingBox();
  const attachRect = await attachments.boundingBox();
  const textareaRect = await page.getByTestId("composer-box").locator("textarea").boundingBox();
  const statusRect = await status.boundingBox();
  const leftRect = await status.locator(".status-left").boundingBox();
  const rightRect = await right.boundingBox();
  const contextRect = await right.getByTestId("context-trigger").boundingBox();
  const modelRect = await right.getByTestId("model-badge").boundingBox();
  const thinkingRect = await right.getByTestId("thinking-badge").boundingBox();

  expect(boxRect).not.toBeNull();
  expect(facetRect).not.toBeNull();
  expect(attachRect).not.toBeNull();
  expect(textareaRect).not.toBeNull();
  expect(statusRect).not.toBeNull();
  expect(leftRect).not.toBeNull();
  expect(rightRect).not.toBeNull();
  expect(contextRect).not.toBeNull();
  expect(modelRect).not.toBeNull();
  expect(thinkingRect).not.toBeNull();

  expect(facetRect!.y).toBeLessThan(boxRect!.y + 2);
  expect(attachRect!.x).toBeLessThan(textareaRect!.x);
  expect(attachRect!.x).toBeGreaterThanOrEqual(boxRect!.x);
  expect(leftRect!.x).toBeLessThan(rightRect!.x);
  expect(contextRect!.x).toBeGreaterThan(thinkingRect!.x);
  expect(contextRect!.x).toBeGreaterThan(modelRect!.x);
  expect(contextRect!.x + contextRect!.width).toBeLessThanOrEqual(statusRect!.x + statusRect!.width + 1);
});

test("model and thinking remain separate popup controls", async ({ page }) => {
  const model = page.getByTestId("model-badge");
  const thinking = page.getByTestId("thinking-badge");

  await model.click();
  const search = page.getByPlaceholder("Search models…");
  await expect(search).toBeVisible();
  await search.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mp .panel").first()).not.toBeVisible();

  await thinking.click();
  const thinkingPanel = page.getByRole("listbox", { name: "Thinking level" });
  await expect(thinkingPanel).toBeVisible();
  await thinkingPanel.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Thinking level" })).not.toBeVisible();
});

// --- Empty prompt as a "continue" signal (issue #21) ---
// When the session is idle, an empty prompt (Enter or Send button with an empty
// composer) acts as a "continue" signal, mirroring the polytoken TUI. An empty
// mid-turn steer or an empty first message for a new session remains blocked.

const composerTextarea = (page: import("@playwright/test").Page) =>
  page.getByTestId("composer-box").locator("textarea");
const sendButton = (page: import("@playwright/test").Page) =>
  page.locator("button.send");

test("send button is enabled when idle and the composer is empty", async ({
  page,
}) => {
  // After gotoFresh the greeting has settled (idle). The composer is empty.
  await expect(composerTextarea(page)).toHaveValue("");
  await expect(sendButton(page)).not.toBeDisabled();
});

test("Enter on an empty idle composer sends a prompt and starts a turn", async ({
  page,
}) => {
  const textarea = composerTextarea(page);
  await expect(textarea).toHaveValue("");
  // Focus and press Enter on the empty composer.
  await textarea.click();
  await page.keyboard.press("Enter");
  // The mock driver replies to the empty prompt: a second turn settles.
  await waitForSettledWorkBlocks(page, 2);
  // The composer cleared after sending.
  await expect(textarea).toHaveValue("");
});

test("clicking Send on an empty idle composer sends a prompt", async ({
  page,
}) => {
  const textarea = composerTextarea(page);
  await expect(textarea).toHaveValue("");
  await sendButton(page).click();
  // A new turn appears (second settled work block).
  await waitForSettledWorkBlocks(page, 2);
  await expect(textarea).toHaveValue("");
});

test("send button is disabled when empty during a streaming turn", async ({
  page,
}) => {
  // Start a turn that stays running (streamhold) so we can assert mid-turn state.
  await drive(page, "streamhold");
  // Wait for the turn to be active — the composer placeholder switches to "Queue a
  // message…" when streaming.
  await expect(composerTextarea(page)).toHaveAttribute(
    "placeholder",
    "Queue a message…",
  );
  // The composer is empty; the send button must be disabled (empty steer blocked).
  await expect(composerTextarea(page)).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();
});

test("send button is disabled when drafting a new session and the composer is empty", async ({
  page,
}) => {
  // Open a new-session draft via keyboard shortcut (Ctrl+N on CI Chromium).
  await page.keyboard.press("Control+n");
  // Confirm drafting is active — the placeholder switches to the draft prompt.
  await expect(composerTextarea(page)).toHaveAttribute(
    "placeholder",
    "Describe a task or ask a question…",
  );
  await expect(composerTextarea(page)).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();
});
