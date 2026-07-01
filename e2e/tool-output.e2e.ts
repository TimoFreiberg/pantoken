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

  // The ToolCard renders directly in the work body — open its body.
  const head = page.getByTestId("work-body").last().locator(":scope > .tool > .head");
  await expect(head).toBeVisible();
  await head.click();

  const tool = page.getByTestId("work-body").last().locator(":scope > .tool");
  const pre = tool.locator(".out");
  await expect(pre).toBeVisible();
  const bar = tool.locator(".out-bar");

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
