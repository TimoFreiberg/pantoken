import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// The mock's background session (older-session) that the `bgrun` script drives
// through a running → done turn; the active one is the greeting session.
const BG = "Explore the fold reducer";
const ACTIVE = "Wire up the WebSocket bridge";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

/** Resolve a CSS custom property to its computed color value on the page. */
async function resolvedToken(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
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

test("idle (read) session titles fade to muted text; active and running do not", async ({
  page,
}) => {
  await openSidebar(page);

  // Baseline: both the viewed session (ACTIVE) and the idle background session
  // (BG) have `read` status.
  await expect(statusOf(page, ACTIVE)).toHaveAttribute("data-state", "read");
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "read");

  // Check title color in both light and dark themes.
  for (const theme of ["light", "dark"] as const) {
    await page
      .locator("html")
      .evaluate((el, value) => el.setAttribute("data-theme", value), theme);

    const [textColor, mutedColor] = await Promise.all([
      resolvedToken(page, "--text"),
      resolvedToken(page, "--text-muted"),
    ]);

    // AC.1: BG (non-viewed, read) title fades to --text-muted.
    await expect(nameOf(page, BG)).toHaveCSS("color", mutedColor);

    // AC.3: ACTIVE (viewed, read) is exempt — stays --text.
    await expect(nameOf(page, ACTIVE)).toHaveCSS("color", textColor);
  }

  // Reset to light and drive a background turn so BG transitions to `running`.
  await page
    .locator("html")
    .evaluate((el) => el.setAttribute("data-theme", "light"));

  await drive(page, "bgrun");
  await expect(statusOf(page, BG)).toHaveAttribute("data-state", "running");

  // AC.2: a running session's title is NOT faded — it stays --text.
  const textColor = await resolvedToken(page, "--text");
  await expect(nameOf(page, BG)).toHaveCSS("color", textColor);
});
