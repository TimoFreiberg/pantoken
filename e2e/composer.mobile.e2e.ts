import { expect, test, type Page } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// Touch-device composer behavior (Pixel 7 project → hasTouch). On a phone a bare Enter
// must insert a newline so multi-line prompts are typeable; send is the button (or a
// hardware ⌘/Ctrl+Enter). Desktop keeps Enter-to-send, covered elsewhere.

const composer = (page: Page) => page.locator(".composer-wrap textarea");

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("mobile: a bare Enter inserts a newline instead of sending", async ({
  page,
}) => {
  const box = composer(page);
  await box.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("line two");
  // The Enter did NOT submit: the draft survives with an embedded newline and no user
  // bubble was appended for it.
  await expect(box).toHaveValue("line one\nline two");
  await expect(page.locator(".row.user", { hasText: "line one" })).toHaveCount(
    0,
  );
});

test("mobile: the send button submits the prompt", async ({ page }) => {
  const box = composer(page);
  await box.click();
  await page.keyboard.type("sent from the button");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The button still sends: composer clears and the message lands in the transcript.
  await expect(box).toHaveValue("");
  await expect(
    page.locator(".row.user", { hasText: "sent from the button" }),
  ).toBeVisible();
});
