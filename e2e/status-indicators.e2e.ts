import { expect, type Page, test } from "@playwright/test";
import {
  drive,
  gotoFresh,
  openSidebar,
  waitForSettledWorkBlocks,
  wheelUp,
} from "./helpers.js";

// The mock's background session (older-session) that the `bgrun` script drives
// through a running → done turn; the active one is the greeting session.
const BG = "Explore the fold reducer";
const ACTIVE = "Wire up the WebSocket bridge";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** Resolve a CSS color expression to its computed value on the page. */
async function resolvedColor(page: Page, value: string): Promise<string> {
  return page.evaluate((colorValue) => {
    const probe = document.createElement("span");
    probe.style.color = colorValue;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, value);
}

/** Resolve a CSS custom property to its computed color value on the page. */
async function resolvedToken(page: Page, token: string): Promise<string> {
  return resolvedColor(page, `var(${token})`);
}

/** The status-indicator span on a given session's sidebar row. */
function statusOf(page: Page, title: string) {
  return page
    .getByTestId("sidebar")
    .locator(".row", { hasText: title })
    .getByTestId("session-status");
}

/** The `.name` title span on a given session's sidebar row. */
function nameOf(page: Page, title: string) {
  return page
    .getByTestId("sidebar")
    .locator(".row", { hasText: title })
    .locator(".name");
}

test("a background session shows running, then done, then clears on open", async ({
  page,
}) => {
  await openSidebar(page);

  // Baseline: the session you're viewing is read, and the idle background one too.
  await expect(statusOf(page, ACTIVE)).toHaveAttribute("data-state", "read");
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "read");

  // Drive a *background* turn — its row shows the running indicator while the
  // active session stays read (the turn never touches the focused transcript).
  await drive(page, "bgrun");
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "running");
  await expect(statusOf(page, ACTIVE)).toHaveAttribute("data-state", "read");

  // When the background turn finishes it becomes done (new since last viewed). Done
  // renders a distinct check badge (not the plain unread dot) so it stands out at a glance.
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "done");
  await expect(statusOf(page, BG).locator(".attention-symbol")).toHaveText("✓");

  // Opening it marks it read again.
  await page.getByTestId("sidebar").locator(".row", { hasText: BG }).click();
  await openSidebar(page); // the mobile drawer closes on navigate; desktop is a no-op
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "read");
});

// ─── Active-session unread (merged from active-unread.e2e.ts) ─────────────────────
// The active (focused) session is normally "read", but should flag unread when the agent
// appends content below the fold while you're scrolled up reading scrollback — the same signal
// as the "New messages ↓" pill, reflected in the sidebar row. Cleared on scroll-to-bottom.

test("scrolling up while the agent appends content flags the active session unread", async ({
  page,
}) => {
  // Build a transcript taller than the fold so top and bottom differ.
  for (let i = 0; i < 3; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 4);

  await openSidebar(page);
  const status = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" })
    .getByTestId("session-status");
  // The active session starts read.
  await expect(status).toHaveAttribute("data-state", "read");

  // Scroll up so we're no longer pinned to the bottom — via real wheel input
  // (not programmatic scrollTop) so the input-gated pin registers it as user
  // action and un-pins.
  const scroller = page.locator(".scroller");
  const gap = () =>
    scroller.evaluate(
      (el) =>
        (el as HTMLElement).scrollHeight -
        (el as HTMLElement).scrollTop -
        (el as HTMLElement).clientHeight,
    );
  await wheelUp(page, 600);
  await expect.poll(gap).toBeGreaterThan(80); // genuinely scrolled up off the bottom

  // The agent appends a new turn while we're scrolled up — it lands below the viewport.
  await drive(page, "reply");

  // The "New messages ↓" pill appears AND the active session's row flags unread.
  await expect(page.getByTestId("new-messages-pill")).toBeVisible();
  await expect(status).toHaveAttribute("data-state", "unread");

  // Jumping to the bottom (you've now seen it) clears both.
  await page.getByTestId("new-messages-pill").click();
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);
  await expect(status).toHaveAttribute("data-state", "read");
});
