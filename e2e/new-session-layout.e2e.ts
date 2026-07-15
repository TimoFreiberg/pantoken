import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("deferred new sessions centre the real composer without the old hero", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  const view = page.getByTestId("new-session");
  const composer = view.getByRole("group", { name: "Message composer" });
  await expect(
    view.getByRole("heading", { name: "What would you like to work on?" }),
  ).toBeVisible();
  await expect(composer).toHaveCount(1);
  await expect(view.getByText("Created when you send")).toBeVisible();
  await expect(view.getByText("Nothing is created until you send")).toHaveCount(
    0,
  );
  await expect(view.getByRole("button", { name: /Cancel/ })).toHaveCount(0);

  const viewBox = await view.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(viewBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const centre = composerBox!.y + composerBox!.height / 2;
  const relativeCentre = (centre - viewBox!.y) / viewBox!.height;
  expect(relativeCentre).toBeGreaterThan(0.32);
  expect(relativeCentre).toBeLessThan(0.55);
});

test("existing sessions keep the composer at the bottom", async ({ page }) => {
  const chat = page.locator(".chat");
  const composer = page.getByRole("group", { name: "Message composer" });
  const chatBox = await chat.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(chatBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const bottomGap =
    chatBox!.y + chatBox!.height - (composerBox!.y + composerBox!.height);
  expect(Math.abs(bottomGap)).toBeLessThan(2);
  await expect(page.getByText("What would you like to work on?")).toHaveCount(
    0,
  );
});

test("first send moves directly from centred draft to transcript layout", async ({
  page,
}) => {
  const oldPrompt = page.getByText("Add a /health route to the server");
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await page
    .getByPlaceholder("Describe a task or ask a question…")
    .fill("start from the centre");
  await page
    .getByPlaceholder("Describe a task or ask a question…")
    .press("Enter");

  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(page.locator(".row.user .bubble").first()).toHaveText(
    "start from the centre",
  );
  await expect(oldPrompt).toHaveCount(0);
  const chatBox = await page.locator(".chat").boundingBox();
  const composerBox = await page
    .getByRole("group", { name: "Message composer" })
    .boundingBox();
  expect(chatBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const bottomGap =
    chatBox!.y + chatBox!.height - (composerBox!.y + composerBox!.height);
  expect(Math.abs(bottomGap)).toBeLessThan(2);
});

test("draft Escape remains available after removing the central Cancel button", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const input = page.getByPlaceholder("Describe a task or ask a question…");
  await input.focus();
  await input.press("Escape");
  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
});
