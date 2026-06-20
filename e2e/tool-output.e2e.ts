import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a long tool output offers copy + an inline expand past the scrollbox cap", async ({
  context,
  page,
}) => {
  await drive(page, "longoutput");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page, "last");

  // Reveal the ToolCard from its summary wrapper, then open its body.
  const summary = page.locator(".tool.summary").last();
  await summary.locator(":scope > .head").click();
  const innerHead = summary.locator(":scope > .body > .tool > .head");
  await expect(innerHead).toBeVisible();
  await innerHead.click();

  const pre = summary.locator(".tool .out");
  await expect(pre).toBeVisible();
  const bar = summary.locator(".out-bar");

  // The 40-line log overflows the 320px cap, so an Expand control appears; expanding
  // drops the cap (the .expanded class) and the toggle flips to Collapse.
  const expand = bar.getByRole("button", { name: "Expand", exact: true });
  await expect(expand).toBeVisible();
  await expect(pre).not.toHaveClass(/expanded/);
  await expand.click();
  await expect(pre).toHaveClass(/expanded/);
  await expect(
    bar.getByRole("button", { name: "Collapse", exact: true }),
  ).toBeVisible();

  // Copy round-trips the whole output to the clipboard and flashes "Copied".
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await bar.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(
    bar.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("40 pass, 0 fail");
});
