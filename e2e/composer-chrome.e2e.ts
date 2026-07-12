import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

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
