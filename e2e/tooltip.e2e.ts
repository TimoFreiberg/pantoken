import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
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
  expect(errors).toEqual([]);
});

test("keyboard tooltip closes cleanly when its focused control unmounts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const btn = page.getByRole("button", { name: "Collapse sidebar" });
  await btn.focus();
  await expect(page.locator(".tip")).toBeVisible();

  // Activating this focused button replaces the expanded sidebar (and the
  // button itself), which dispatches focusout synchronously during teardown.
  await page.keyboard.press("Enter");

  await expect(btn).toHaveCount(0);
  await expect(page.locator(".tip")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ─── Tooltip cleanup (merged from tooltip-cleanup.e2e.ts, issue #20) ───────────────
// Issue #20: unnecessary tooltips removed from self-documenting UI elements.
// These tests assert that the `title` attribute is gone from elements whose
// function is obvious from their visible label/icon, while elements that carry
// extra hover data (status spans, group paths) keep theirs.

// AC.3: The New Session button has no tooltip but shows a fading ⌘N hint.
test("new-session button has no title, but shows a ⌘N kbd hint on hover", async ({
  page,
}) => {
  const btn = page.getByTestId("sidebar-new-session").locator(".new-btn");
  await expect(btn).not.toHaveAttribute("title", /.+/);

  // The accessible name is exactly "New session" (the decorative + is aria-hidden).
  // exact: true avoids matching the project "+" buttons ("New session in pantoken", etc.).
  await expect(
    page.getByRole("button", { name: "New session", exact: true }),
  ).toBeVisible();
  const plus = btn.locator(".plus");
  await expect(plus).toHaveAttribute("aria-hidden", "true");

  // The kbd hint exists and is hidden (opacity 0) at rest.
  const hint = btn.locator(".hotkey-hint");
  await expect(hint).toHaveText("⌘N");
  await expect(hint).toHaveCSS("opacity", "0");

  // Hover reveals it.
  await btn.hover();
  await expect(hint).toHaveCSS("opacity", "1");
});

// AC.4/AC.6/AC.8/AC.12 — controls that are self-explanatory from their visible
// label/icon carry no `title` tooltip (deliberate absence, issue #20). One
// consolidated test guards the shared absence; the group-toggle additionally
// pins that it KEEPS its project-path tooltip.
test("self-explanatory controls have no title attribute", async ({ page }) => {
  // AC.4: The search toggle IconButton (visible when search is closed).
  const toggle = page.getByTestId("sidebar-search-toggle");
  await expect(toggle).not.toHaveAttribute("title", /.+/);

  // Open search to reveal the input.
  await toggle.click();
  const input = page.getByTestId("sidebar-search-input");
  await expect(input).toBeVisible();
  await expect(input).not.toHaveAttribute("title", /.+/);

  // AC.6: Todos and jobs in the right sidebar.
  await drive(page, "context");
  const todoBtn = page.locator(".todo-btn").first();
  await expect(todoBtn).toBeVisible();
  await expect(todoBtn).not.toHaveAttribute("title", /.+/);
  const jobBtn = page.locator(".job-btn").first();
  await expect(jobBtn).toBeVisible();
  await expect(jobBtn).not.toHaveAttribute("title", /.+/);

  // AC.8: The working-indicator elapsed-time span (visible while a turn is
  // streaming).
  await drive(page, "streamhold");
  const elapsed = page.getByTestId("working-elapsed");
  await expect(elapsed).toBeVisible();
  await expect(elapsed).not.toHaveAttribute("title", /.+/);

  // AC.12: The group-toggle retains its project-path tooltip, but the
  // project-new (+) button loses its tooltip.
  await openSidebar(page);
  // The greeting session's project group is "pantoken".
  const group = page.getByTestId("sidebar").locator(".group", {
    hasText: "pantoken",
  });
  const groupToggle = group.locator(".group-toggle").first();
  await expect(groupToggle).toHaveAttribute("title", /.+/);

  const newBtn = group.locator(".project-new").first();
  await expect(newBtn).not.toHaveAttribute("title", /.+/);
});

// AC.7: The ToolCard duration span has no title but retains aria-label.
test("tool card duration span has no title but retains aria-label", async ({
  page,
}) => {
  // Expand the greeting's work block to reveal the tool card.
  const toggle = page.getByTestId("work-toggle").first();
  await toggle.click();
  const duration = page.locator(".tool .duration").first();
  // Duration is visually hidden at rest (opacity 0) but still in the DOM and a11y tree.
  await expect(duration).toHaveCSS("opacity", "0");
  await expect(duration).not.toHaveAttribute("title", /.+/);
  await expect(duration).toHaveAttribute("aria-label", /.+/);
});
