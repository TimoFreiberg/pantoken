import { expect, test } from "@playwright/test";
import { drive, gotoFresh, scrollUpViaKeyboard, waitForSettledWorkBlocks } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoFresh(page);
});

test("desktop prompt map shows one accessible tick per prompt and previews", async ({ page }) => {
  const map = page.getByTestId("prompt-map");
  await expect(map).toHaveCount(0);

  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 2);
  await expect(map).toBeVisible();
  await expect(map.getByTestId("prompt-map-tick")).toHaveCount(2);

  const tick = map.getByTestId("prompt-map-tick").last();
  await tick.focus();
  await expect(page.getByTestId("prompt-map-preview")).toContainText("Show me the streamed reply");
  await expect(page.getByTestId("prompt-map-preview")).toContainText("That confirms it");
  await expect(tick).toHaveAttribute("aria-label", /Prompt 2 of 2/);
});

test("clicking a map tick shares prompt navigation and highlights active turns", async ({ page }) => {
  await drive(page, "reply");
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 3);
  const map = page.getByTestId("prompt-map");
  await expect(map.getByTestId("prompt-map-tick")).toHaveCount(3);

  const scroller = page.locator(".scroller");
  await scrollUpViaKeyboard(page);
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(0);
  await map.getByTestId("prompt-map-tick").nth(1).click();
  await expect(page.locator(".row.user.nav-flash")).toHaveCount(1);
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);

  await page.locator(".transcript-wrap").hover();
  await page.getByTestId("prompt-nav-down").click();
  await expect(page.locator(".row.user.nav-flash")).toHaveCount(1);
});

test("long response keeps its prompt interval active after the prompt leaves the viewport", async ({ page }) => {
  await drive(page, "promptmaplong");
  await expect(page.getByText(/Paragraph 26:/)).toBeVisible();
  await drive(page, "reply");
  await expect(page.getByText("Show me the streamed reply script.").last()).toBeVisible();
  const scroller = page.locator(".scroller");
  const longPrompt = page.locator('.transcript-turn[data-prompt-id="u-promptmap-long"]');
  await scroller.evaluate((node) => node.scrollTo({ top: Math.max(0, node.scrollHeight / 2) }));
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() =>
    longPrompt.evaluate((node) => {
      const row = node.getBoundingClientRect();
      const viewport = (node.closest(".scroller") as HTMLElement).getBoundingClientRect();
      return row.top < viewport.top && row.bottom > viewport.top;
    }),
  ).toBe(true);
  await expect(page.getByTestId("prompt-map").getByRole("button", { name: /Show a long response so the prompt map/ })).toHaveClass(/active/);
});

test("prompt map exposes fallback previews for in-progress and tool-only turns", async ({ page }) => {
  await drive(page, "promptmaphold");
  await expect(page.getByText("Pause this prompt while the response is still in progress.")).toBeVisible();
  const map = page.getByTestId("prompt-map");
  await expect(map).toBeVisible();
  const holdTick = map.getByRole("button", { name: /Pause this prompt while the response/ });
  await holdTick.focus();
  await expect(page.getByTestId("prompt-map-preview")).toContainText("Response in progress");

  await drive(page, "promptmaptoolonly");
  await expect(page.getByText("Run a tool without producing a final response.")).toBeVisible();
  const toolTick = map.getByRole("button", { name: /Run a tool without producing/ });
  await toolTick.focus();
  await expect(page.getByTestId("prompt-map-preview")).toContainText("No final response");
});
