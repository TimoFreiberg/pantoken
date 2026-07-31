import { expect, test, type Locator } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks, wheelUp } from "./helpers.js";

// Smoke tests for the pinned-scroll-follow behavior. The pin DECISION is guarded by
// scroll-follow.test.ts (pure unit tests); these specs catch gross wiring breakage
// (nextPinned throwing, `pinned` never updating, the pill testid disappearing).
//
// Under input-gating, programmatic scrollTop can't un-pin (no user-input event sets
// `userScrolling`), so these tests use real wheel input (wheelUp helper) when they need
// to simulate a user scrolling up. Content-shrink tests (which don't need user input)
// can still use programmatic DOM manipulation since the input gate holds the pin.

/** Read the current gap (scrollHeight - scrollTop - clientHeight) of the scroller. */
function gapFn(scroller: Locator) {
  return scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight -
      (el as HTMLElement).scrollTop -
      (el as HTMLElement).clientHeight,
  );
}

/** Build `replies` reply turns (plus the greeting) and wait for `count` settled
 *  work blocks. Leaves the transcript pinned at the live tail. */
async function buildTallTranscript(
  page: import("@playwright/test").Page,
  replies: number,
): Promise<void> {
  for (let i = 0; i < replies; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, replies + 1);
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// ── AC.6: content-shrink while pinned → viewport follows to the new bottom ────────────

test("content shrinks while pinned → viewport follows to the new bottom", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () => gapFn(scroller);

  // Build a tall transcript so top and bottom differ.
  await buildTallTranscript(page, 3);
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
  // clamps/adjusts `scrollTop`, a scroll event fires with `top < prevTop`. Under input-gating
  // `userScrolling` is false (no user-input event fired), so the input gate holds the pin
  // and the ResizeObserver re-asserts to the new shorter bottom.
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
  const gap = () => gapFn(scroller);

  // Build a tall transcript so top and bottom differ.
  await buildTallTranscript(page, 3);
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

// ── AC.3: touch-drag scroll-up un-pins the viewport ─────────────────────────────────

test("a touch-drag scroll-up un-pins the viewport and shows the pill on new content", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () => gapFn(scroller);

  // Build a tall transcript so top and bottom differ.
  await buildTallTranscript(page, 3);
  await expect.poll(gap).toBeLessThan(5); // pinned at the live tail

  // Simulate a touch-drag scroll-up. ontouchstart on .scroller sets userScrolling, so
  // the subsequent scroll event un-pins. Headless Chrome doesn't scroll from synthetic
  // touchmove, so we dispatch touchstart (to set userScrolling=true) then scroll
  // programmatically — the resulting onScroll sees userScrolling and un-pins.
  await scroller.evaluate((el) => {
    const target = el as HTMLElement;
    const rect = target.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.bottom - 50;
    // touchstart sets userScrolling=true via the ontouchstart handler
    target.dispatchEvent(
      new TouchEvent("touchstart", {
        touches: [
          new Touch({ identifier: 0, target, clientX: startX, clientY: startY }),
        ],
        cancelable: true,
        bubbles: true,
      }),
    );
    // Now scroll up programmatically — onScroll will see userScrolling=true and un-pin
    target.scrollTop = 0;
    target.dispatchEvent(
      new TouchEvent("touchend", {
        touches: [],
        cancelable: true,
        bubbles: true,
      }),
    );
  });
  // The touch set userScrolling; onScroll un-pinned because scrollTop moved up.
  await page.waitForTimeout(100);
  // Drive the mock to append new content — it should land below the fold.
  await drive(page, "reply");
  // The "New messages ↓" pill appears (un-pinned + new content below).
  await expect(page.getByTestId("new-messages-pill")).toBeVisible({
    timeout: 5000,
  });
});

// ── AC.5: find-in-transcript navigation un-pins the viewport ─────────────────────────

test("find-in-transcript jump to match un-pins the viewport so it stays at the match", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");
  const gap = () => gapFn(scroller);

  // Build a tall transcript so top and bottom differ.
  await buildTallTranscript(page, 3);
  await expect.poll(gap).toBeLessThan(5); // pinned at the live tail

  // Open find-in-transcript (⌘F).
  await page.keyboard.press("Meta+f");
  const search = page.getByTestId("transcript-search");
  await expect(search).toBeVisible();

  // Type a query that matches content at the TOP of the transcript (above the fold).
  // The greeting's user prompt is "Add a /health route to the server and a smoke test
  // for it." — matching it scrolls the viewport to the top, far from the live bottom.
  const input = search.locator(".find-input");
  await input.fill("health route");
  // Wait for the debounced search to run (110ms) and show matches.
  await expect.poll(() =>
    page.getByTestId("find-count").textContent(),
  ).not.toContain("0/0");

  // The initial search already calls scrollToCurrent (scheduleSearch(true)) which bumps
  // searchScrollN and sets pinned=false. Press Enter to re-jump (belt and suspenders).
  await input.press("Enter");
  await page.waitForTimeout(500); // let scrollIntoView + searchScrollN effect settle

  // The viewport should now be at the match near the top, NOT at the live bottom.
  await expect.poll(gap, { timeout: 5000 }).toBeGreaterThan(80);

  // Drive the mock to append new content while we're at the search match. The streaming-pin
  // effect must NOT yank back to the bottom (pinned is false from searchScrollN).
  await drive(page, "reply");
  await page.waitForTimeout(500);

  // The "New messages ↓" pill should appear — pinned is false (from the search jump)
  // and new content landed below the fold. If the streaming-pin effect had re-pinned,
  // the viewport would have followed the stream to the bottom and no pill would appear.
  await expect(page.getByTestId("new-messages-pill")).toBeVisible({
    timeout: 5000,
  });
});

test("prompt-nav ↑ un-pins so streaming content doesn't yank back to the bottom", async ({
  page,
}) => {
  // Build enough turns that prompt-nav ↑ can jump well away from the live tail.
  await buildTallTranscript(page, 5);

  const gap = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      return sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    });

  // Scroll up first so prompt-nav ↑ has an earlier prompt to jump to (at the
  // bottom, ↑ targets the most recent prompt which may still be in view).
  await wheelUp(page, 500);
  await expect.poll(gap).toBeGreaterThan(80);

  // Click prompt-nav ↑ to jump to an earlier prompt. This is a programmatic
  // scroll that explicitly sets pinned=false — without that, the input gate
  // would hold the pin and the streaming-pin effect would yank back on the
  // next content delta.
  await page.locator(".transcript-wrap").hover();
  await page.getByTestId("prompt-nav-up").click();
  await page.waitForTimeout(500);

  // The viewport should now be scrolled up, away from the live tail.
  await expect.poll(gap, { timeout: 5000 }).toBeGreaterThan(80);

  // Drive the mock to append new content. The streaming-pin effect must NOT
  // yank back to the bottom — pinned is false (set by prompt-nav ↑).
  await drive(page, "reply");
  await page.waitForTimeout(500);

  // The "New messages ↓" pill should appear — pinned is false and new content
  // landed below the fold. If the explicit pinned=false were missing, the
  // streaming-pin effect would have re-pinned and followed to the bottom.
  await expect(page.getByTestId("new-messages-pill")).toBeVisible({
    timeout: 5000,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Composer scroll-jump (merged from composer-scroll-jump.e2e.ts, issue #64)
//
// Regression guard for #64: when the user types in the composer and the textarea grows
// (wraps to a new line), the transcript's last paragraph must not jump below the viewport.
// The pinned-to-bottom invariant must hold across composer-driven viewport resizes.
//
// The scroller has `overflow-anchor: none` globally (added in #86), so Chrome no longer
// masks the gap on viewport shrink — simulating the iOS Safari / WKWebView failure
// surface where overflow-anchor is unreliable. Without the fix, a single line-wrap
// creates ~68px of gap; with the fix, the scroller ResizeObserver re-asserts the bottom
// and the gap stays at 0.
// ═══════════════════════════════════════════════════════════════════════════

test.describe("composer scroll-jump (#64)", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
    // Build a tall transcript so the scroller pins to the bottom and top != bottom.
    await buildTallTranscript(page, 4);
  });

  test("AC.1 — typing a line-wrap in the composer keeps the transcript pinned to the bottom", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const gap = () => gapFn(scroller);
    const textarea = page.locator(".composer-wrap textarea");

    // Start pinned at the bottom.
    await expect.poll(gap).toBeLessThan(5);

    // Focus the composer and type enough text to force a line wrap. The textarea starts
    // at rows=1; a single long line wraps, growing the composer by one line (~24px) and
    // shrinking the scroller's clientHeight via flex reflow.
    await textarea.click();
    await textarea.fill(
      "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
    );

    // The gap must remain under 5px — the last paragraph did not jump below the viewport.
    // Without the fix, the gap opens to ~68px (the composer grew, shrinking clientHeight,
    // and overflow-anchor is off so scrollTop stays put).
    await expect.poll(gap).toBeLessThan(5);
  });

  test("AC.2 — grow→shrink→grow cycle keeps the transcript pinned throughout", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const gap = () => gapFn(scroller);
    const textarea = page.locator(".composer-wrap textarea");

    // Start pinned at the bottom.
    await expect.poll(gap).toBeLessThan(5);

    // Grow: type wrapping text.
    await textarea.click();
    await textarea.fill(
      "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
    );
    await expect.poll(gap).toBeLessThan(5);

    // Shrink: delete the text (composer shrinks back to one row).
    await textarea.fill("");
    await expect.poll(gap).toBeLessThan(5);

    // Grow again: type wrapping text once more.
    await textarea.fill(
      "Another long line of text that wraps to multiple lines, growing the composer again after the shrink",
    );
    await expect.poll(gap).toBeLessThan(5);
  });

  test("AC.3 — proactive re-assert fired: composerResizeN incremented after typing a wrapping line", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const textarea = page.locator(".composer-wrap textarea");

    await expect.poll(() => gapFn(scroller)).toBeLessThan(5);

    // Snapshot the counter before (may be > 0 from prior setup keystrokes).
    const before = Number(
      (await scroller.getAttribute("data-composer-resize-n")) ?? 0,
    );

    await textarea.click();
    await textarea.fill(
      "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
    );

    // The proactive path sets dataset.composerResizeN; the async viewportObserver
    // does NOT. So if the attribute incremented, the proactive effect ran.
    await expect
      .poll(async () =>
        Number(
          (await scroller.getAttribute("data-composer-resize-n")) ?? 0,
        ),
      )
      .toBeGreaterThan(before);
    // And the gap stayed closed (the re-assert did its job).
    await expect.poll(() => gapFn(scroller)).toBeLessThan(5);
  });

  test("AC.4 — a reader scrolled up is not yanked down when the composer grows", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const textarea = page.locator(".composer-wrap textarea");

    // Start pinned at the bottom.
    await expect.poll(() => gapFn(scroller)).toBeLessThan(5);

    // Scroll up — a reader reading scrollback. Via real wheel input so the
    // input-gated pin registers it as a user action and un-pins.
    await wheelUp(page, 400);
    // Confirm we're genuinely scrolled up (pinned should be false now).
    await expect.poll(() => gapFn(scroller)).toBeGreaterThan(80);

    const topBefore = await scroller.evaluate(
      (el) => (el as HTMLElement).scrollTop,
    );
    // Snapshot the proactive tick before typing — it must NOT increment here
    // (the effect bails on `!pinned`). This directly tests the effect's guard,
    // which scrollTop alone cannot (applySettle has its own redundant `!pinned`
    // bail that would also prevent a yank).
    const resizeNBefore = await scroller.getAttribute(
      "data-composer-resize-n",
    );

    // Type a wrapping line — autosize bumps composerResizeN, the proactive
    // effect fires but must bail (pinned === false). scrollTop must not jump.
    await textarea.click();
    await textarea.fill(
      "This is a long line of text that will wrap to multiple lines when typed into the composer textarea, causing it to grow and shrink the transcript viewport",
    );

    const topAfter = await scroller.evaluate(
      (el) => (el as HTMLElement).scrollTop,
    );
    // The reader was NOT yanked to the bottom — scrollTop barely moved (the
    // viewport shrink may nudge it a few px, but not hundreds).
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(20);
    // The proactive effect's `pinned` guard held — it did NOT set the tick
    // attribute (if it had, the guard was removed and this would fail).
    const resizeNAfter = await scroller.getAttribute(
      "data-composer-resize-n",
    );
    expect(resizeNAfter).toBe(resizeNBefore);
  });

  test("AC.5 — a non-wrapping keystroke does not cause the transcript to jump", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const gap = () => gapFn(scroller);
    const textarea = page.locator(".composer-wrap textarea");
    const box = page.locator('[data-testid="composer-box"]');

    // Start pinned at the bottom.
    await expect.poll(gap).toBeLessThan(5);

    // Without the testForHeightReduction optimization, the height="auto" reset on every
    // keystroke would cause a transient layout invalidation → jitter on WKWebView.
    // (overflow-anchor: none is set globally on .scroller — no per-test override needed.)
    // Snapshot the reset counter before (may be > 0 from prior setup keystrokes).
    const resetBefore = Number(
      (await box.getAttribute("data-autosize-reset-n")) ?? 0,
    );

    // Type a single character — the composer stays at one row (no line wrap),
    // so the height doesn't change. The testForHeightReduction optimization
    // skips the height="auto" reset (text grew → no reset needed), avoiding
    // the transient layout invalidation that causes jitter on WKWebView.
    await textarea.click();
    await textarea.fill("a");

    // The reset path did NOT run — the optimization skipped it (text grew).
    // Without the optimization, the reset would have run and incremented this.
    const resetAfter = Number(
      (await box.getAttribute("data-autosize-reset-n")) ?? 0,
    );
    expect(resetAfter).toBe(resetBefore);
    // And the gap stayed under 5px — the transcript did not jump.
    await expect.poll(gap).toBeLessThan(5);
  });
});
