import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a mixed run including bash collapses into one tool-styled summary", async ({
  page,
}) => {
  await drive(page, "search");
  // The search turn settles, so its working section collapses behind "Worked for Ns";
  // reveal it to reach the merged card.
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);

  // 2 reads + 2 greps + 1 find + 1 bash, uninterrupted, fold into ONE card. The header
  // shows the total count plus each distinct tool name once (first-appearance
  // order), using the same card shell/classes as a standalone ToolCard.
  const summary = page.locator(".tool.summary");
  const head = summary.locator(".head");
  await expect(summary).toHaveClass(/ok/);
  await expect(head).toHaveCount(1);
  await expect(head.locator(".name")).toHaveText("6 tools");
  await expect(head.locator(".arg")).toHaveText("read, grep, find, bash");
  await expect(head.locator(".status")).toHaveText("●");
});

test("merged card expands in two steps: the list, then each call", async ({
  page,
}) => {
  await drive(page, "search");
  await expect(page.getByText("Reconnect lives in")).toBeVisible();
  await expandWork(page);
  const card = page.locator(".tool.summary");

  // Step 0 — collapsed: no inner tool cards rendered yet.
  await expect(card.locator(".body")).toHaveCount(0);

  // Step 1 — expand the card: the run shows as 6 collapsed ToolCards. Still no
  // output visible (each ToolCard owns its own inner expand state).
  await card.locator(":scope > .head").click();
  const innerCards = card.locator(":scope > .body > .tool");
  await expect(innerCards).toHaveCount(6);
  await expect(card.locator(":scope > .body > .tool .out")).toHaveCount(0);

  // Step 2 — expand one inner ToolCard: its output appears.
  await innerCards.first().locator(".head").click();
  await expect(
    card.getByText("private reconnect()", { exact: false }),
  ).toBeVisible();
});
