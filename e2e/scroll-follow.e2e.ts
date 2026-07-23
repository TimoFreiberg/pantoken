import { expect, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

// Smoke tests for the pinned-scroll-follow behavior. The pin DECISION is guarded by
// scroll-follow.test.ts (pure unit tests); these specs catch gross wiring breakage
// (nextPinned throwing, `pinned` never updating, the pill testid disappearing).
//
// Previously these tests used `gap < 80` assertions because Chrome's `overflow-anchor`
// masked the gap, making a stricter threshold flaky. With the global `overflow-anchor:
// none` on `.scroller` (added in #86), Chrome no longer masks the gap, so the tests use
// the stricter `gap < 5` threshold — matching composer-scroll-jump.e2e.ts and asserting
// the viewport is truly at the bottom, not just within the 80px bottom zone.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("sending a prompt keeps the transcript following the stream to the bottom", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () =>
    scroller.evaluate(
      (el) =>
        (el as HTMLElement).scrollHeight -
        (el as HTMLElement).scrollTop -
        (el as HTMLElement).clientHeight,
    );

  // Build a transcript tall enough that top and bottom differ.
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 4);
  await expect.poll(gap).toBeLessThan(5); // pinned at the live tail

  // Send a fresh prompt and let its turn stream + settle. The viewport must follow the
  // new output to the bottom — the just-sent bubble and its reply in view, not left below
  // the fold behind a "New messages ↓" pill.
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 5);
  await expect.poll(gap).toBeLessThan(5);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

// ── AC.6: content-shrink while pinned → viewport follows to the new bottom ────────────

test("content shrinks while pinned → viewport follows to the new bottom", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () =>
    scroller.evaluate(
      (el) =>
        (el as HTMLElement).scrollHeight -
        (el as HTMLElement).scrollTop -
        (el as HTMLElement).clientHeight,
    );

  // Build a tall transcript so top and bottom differ.
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 4);
  await expect.poll(gap).toBeLessThan(5); // pinned at the live tail

  // Append a tall spacer to `.col` (NOT `.scroller`) so the `.col` ResizeObserver fires,
  // the live-bottom re-assert scrolls to the new bottom, and `scrollHeight` grows.
  await scroller.locator(".col").evaluate((el) => {
    const spacer = document.createElement("div");
    spacer.id = "test-shrink-spacer";
    spacer.style.height = "2000px";
    el.appendChild(spacer);
  });
  // Wait for the ResizeObserver re-assert to follow the growth.
  await expect.poll(gap).toBeLessThan(5);

  // Remove the spacer — this shrinks `scrollHeight`, the content-shrink case. The browser
  // clamps/adjusts `scrollTop`, a scroll event fires with `top < prevTop`, and the new
  // `nextPinned` must hold the pin (not un-pin) so the ResizeObserver re-asserts to the
  // new shorter bottom.
  await scroller.locator(".col").evaluate(() => {
    document.getElementById("test-shrink-spacer")?.remove();
  });

  // The viewport must stay at the new bottom — no stranding, no "New messages ↓" pill.
  await expect.poll(gap, { timeout: 5000 }).toBeLessThan(5);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});

// ── AC.7: content grows via a real user prompt → viewport follows ─────────────────────

test("a user prompt sent while pinned keeps the viewport at the bottom", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () =>
    scroller.evaluate(
      (el) =>
        (el as HTMLElement).scrollHeight -
        (el as HTMLElement).scrollTop -
        (el as HTMLElement).clientHeight,
    );

  // Build a tall transcript so top and bottom differ.
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 4);
  await expect.poll(gap).toBeLessThan(5); // pinned at the live tail

  // Send a real prompt via the composer (not a dev-bar button) — fills the textarea and
  // presses Enter, exercising the full user-facing send path.
  const textarea = page.locator(".composer-wrap textarea");
  await textarea.click();
  await textarea.fill("Tell me more about that");
  await textarea.press("Enter");

  // Wait for the turn to stream and settle. The viewport must follow the new output
  // to the bottom — not left behind a "New messages ↓" pill.
  await waitForSettledWorkBlocks(page, 5);
  await expect.poll(gap, { timeout: 10000 }).toBeLessThan(5);
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
});
