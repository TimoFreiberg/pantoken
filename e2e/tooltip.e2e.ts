import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The global Tooltip override (client/src/components/Tooltip.svelte) reuses every
// element's `title` to render a themed tooltip on hover, suppressing the browser's
// own slow/unstyled one. Hover-only by design, so this lives in the desktop project.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("hovering a titled control shows a themed tooltip, then restores the title", async ({
  page,
}) => {
  // Locate by accessible name (aria-label), NOT by title — the title is what the
  // feature strips on hover, so a title-based locator would stop matching.
  const btn = page.getByRole("button", { name: "Collapse sidebar" });
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("title", "Collapse sidebar");

  // Nothing until the pointer rests on the control.
  await expect(page.locator(".tip")).toHaveCount(0);

  await btn.hover();

  // The themed tooltip appears (after the short delay) carrying the title text...
  const tip = page.locator(".tip");
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText("Collapse sidebar");

  // ...and while ours is up the native `title` is stripped so the browser doesn't
  // render a second, slower tooltip on top of it.
  await expect(btn).not.toHaveAttribute("title", /.+/);

  // Leaving the control tears the tooltip down and puts the native title back, so
  // the attribute (a project convention + accessible description) survives.
  await page.mouse.move(0, 0);
  await expect(page.locator(".tip")).toHaveCount(0);
  await expect(btn).toHaveAttribute("title", "Collapse sidebar");
});
