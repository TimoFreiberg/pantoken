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
  // The title names the action and (per the repo convention) its hotkey, e.g.
  // "Collapse sidebar (⌘B)". Capture the exact string and assert the strip/restore
  // *contract* against it, not a literal label — so a hotkey/label tweak can't break
  // this test the way the bare "Collapse sidebar" literal once did.
  await expect(btn).toHaveAttribute("title", /^Collapse sidebar/);
  const title = (await btn.getAttribute("title")) ?? "";

  // Nothing until the pointer rests on the control.
  await expect(page.locator(".tip")).toHaveCount(0);

  await btn.hover();

  // The themed tooltip appears (after the short delay) carrying the title text...
  const tip = page.locator(".tip");
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText(title);

  // ...and while ours is up the native `title` is stripped so the browser doesn't
  // render a second, slower tooltip on top of it.
  await expect(btn).not.toHaveAttribute("title", /.+/);

  // Leaving the control tears the tooltip down and puts the native title back, so
  // the attribute (a project convention + accessible description) survives.
  await page.mouse.move(0, 0);
  await expect(page.locator(".tip")).toHaveCount(0);
  await expect(btn).toHaveAttribute("title", title);
});

test("tooltip survives a re-render of the element under a resting pointer", async ({
  page,
}) => {
  // A warm session re-renders tracked nodes (tool progress, status changes) while
  // the pointer rests on them. The browser fires mouseout for the removed node but
  // no mouseover for its replacement; the tooltip must re-acquire the fresh node
  // and stay up rather than vanish for good.
  const btn = page.getByRole("button", { name: "Collapse sidebar" });
  // Capture before hover: once the tooltip shows, the native title is stripped. The
  // re-acquire check below compares the clone's title to the *tracked* title, so the
  // clone must carry this exact string (incl. any hotkey suffix) to be re-acquired.
  const title = (await btn.getAttribute("title")) ?? "";
  await btn.hover();
  const tip = page.locator(".tip");
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText(title);

  // Reproduce the exact sequence: fire mouseout for the hovered node (as the
  // browser does just before removing it), then swap in a fresh clone — one that
  // carries the original `title`, like a real template re-render — at the same spot.
  await page.evaluate((title) => {
    const el = document.querySelector(
      '[aria-label="Collapse sidebar"]',
    ) as HTMLElement;
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const clone = el.cloneNode(true) as HTMLElement;
    clone.setAttribute("title", title);
    clone.removeAttribute("data-tip-title");
    el.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, clientX: cx, clientY: cy }),
    );
    el.replaceWith(clone);
  }, title);

  // Still up, still correct — re-acquired onto the replacement node.
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText(title);

  // Re-acquire must keep the strip/restore contract: the fresh node's native title
  // is stripped while ours shows (no double tooltip)...
  const fresh = page.getByRole("button", { name: "Collapse sidebar" });
  await expect(fresh).not.toHaveAttribute("title", /.+/);
  // ...and a genuine leave tears the tip down and restores the title. Use a synthetic
  // mouseout (the node was inserted via JS, so the browser's real hover state for it is
  // unreliable — a real page.mouse.move here is racy).
  await page.evaluate(() => {
    const el = document.querySelector(
      '[aria-label="Collapse sidebar"]',
    ) as HTMLElement;
    el.dispatchEvent(
      new MouseEvent("mouseout", {
        bubbles: true,
        clientX: 0,
        clientY: 0,
        relatedTarget: document.body,
      }),
    );
  });
  await expect(page.locator(".tip")).toHaveCount(0);
  await expect(fresh).toHaveAttribute("title", title);
});
