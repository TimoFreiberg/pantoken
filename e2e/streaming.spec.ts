import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a streamed reply renders user text, assistant text, and a tool call", async ({
  page,
}) => {
  await drive(page, "reply");
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  await expect(
    page.getByText("Here's the plan", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Read file")).toBeVisible();
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();
});

test("a thinking block appears and expands", async ({ page }) => {
  await drive(page, "reply");
  const think = page.getByText("Thought process");
  await expect(think).toBeVisible();
  await think.click();
  await expect(
    page.getByText("Let me think about the cleanest way", { exact: false }),
  ).toBeVisible();
});

test("typing a prompt then sending clears the composer", async ({ page }) => {
  const box = page.getByPlaceholder("Message pilot…");
  await box.fill("hello there");
  await box.press("Enter");
  await expect(page.getByText("hello there")).toBeVisible();
  await expect(box).toHaveValue("");
});
