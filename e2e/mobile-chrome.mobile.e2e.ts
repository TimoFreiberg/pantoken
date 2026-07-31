import { expect, test, type Locator, type Page } from "@playwright/test";
import { drive, gotoFresh, openSettings, openSidebar } from "./helpers.js";

// Runs under the "mobile" project.

async function expectTouchSafe(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

/** Dispatch a synthetic left-edge swipe on a surface. A touch begins inside the 24px edge
 *  strip, then drags rightward, then lifts. `dx` is raw finger travel in px; the post-
 *  resistance follow distance equals dx (resistance 1), and the arm threshold is 88px. */
async function swipeFromLeftEdge(
  page: Page,
  selector: string,
  dx: number,
): Promise<void> {
  await page.evaluate(
    ({ selector, dx }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) throw new Error(`swipeFromLeftEdge: no element for ${selector}`);
      const startX = 12; // inside the 24px edge strip
      const touch = (clientX: number) =>
        new Touch({ identifier: 1, target: el, clientX, clientY: 200 });
      const fire = (type: string, clientX: number, moving: boolean) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: moving ? [touch(clientX)] : [],
            changedTouches: [touch(clientX)],
          }),
        );
      fire("touchstart", startX, true);
      fire("touchmove", startX + dx * 0.5, true);
      fire("touchmove", startX + dx, true);
      fire("touchend", startX + dx, false);
    },
    { selector, dx },
  );
}

/** Dispatch a synthetic top-edge pull on a scroll container. Force scrollTop=0 first (the
 *  transcript can be pinned to the bottom) so the gesture engages, then fire touchstart →
 *  a downward touchmove → touchend, all cancelable. `dy` is raw finger travel in px;
 *  the post-resistance indicator distance is ≈ dy * 0.5 (arm threshold is 64px). */
async function pullDown(
  page: Page,
  selector: string,
  dy: number,
): Promise<void> {
  await page.evaluate(
    ({ selector, dy }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) throw new Error(`pullDown: no element for ${selector}`);
      el.scrollTop = 0;
      const startY = 12;
      const touch = (clientY: number) =>
        new Touch({ identifier: 1, target: el, clientX: 24, clientY });
      const fire = (type: string, clientY: number, moving: boolean) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: moving ? [touch(clientY)] : [],
            changedTouches: [touch(clientY)],
          }),
        );
      fire("touchstart", startY, true);
      fire("touchmove", startY + dy * 0.5, true);
      fire("touchmove", startY + dy, true);
      fire("touchend", startY + dy, false);
    },
    { selector, dy },
  );
}

const offline = (page: Page) =>
  page.getByText("the agent keeps running", { exact: false });

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// ── Mobile header ────────────────────────────────────────────────────────────

test.describe("Mobile header", () => {
  // Journey: verify the mobile header is quiet with a touch-safe sidebar button,
  // open the sidebar to check settings and context buttons, open the chooser to
  // verify context is hidden, then open settings to confirm the panel appears.
  test("mobile header is quiet; sidebar and context buttons are touch-safe; chooser hides context", async ({
    page,
  }) => {
    const header = page.locator("header.hdr");
    await expect(header.locator(".conn")).toHaveCount(0);
    // The mock device reports a failed/blocked push subscription. This is intentionally
    // the one notification state that interrupts the quiet header, and it stays actionable.
    const notificationProblem = header.locator(".bell");
    await expect(notificationProblem).toBeVisible();
    await expect(notificationProblem).toHaveClass(/denied|error/);
    await expect(notificationProblem).toBeEnabled();
    await expect(header.locator(".sub")).toBeHidden();
    await expect(header.getByTestId("settings-toggle")).toHaveCount(0);

    await expectTouchSafe(header.getByTestId("sidebar-open"));

    // --- open sidebar; settings is icon-only, context lives in the header ---
    await openSidebar(page);
    const settings = page.getByTestId("settings-toggle");
    await expect(settings).toBeVisible();
    // Settings is now icon-only — no "Settings" text label.
    await expect(settings).not.toContainText("Settings");
    await expectTouchSafe(settings);

    // Context is no longer in the sidebar footer; the header entry is always visible.
    await expect(page.getByTestId("sidebar-context")).toHaveCount(0);
    const contextOpen = page.getByTestId("context-open");
    await expect(contextOpen).toBeVisible();
    await expectTouchSafe(contextOpen);

    // --- chooser hides inactive-session Context ---
    await page.getByTestId("sidebar-new-session").getByRole("button").click();
    // afterNavigate closes the sidebar drawer on mobile — the chooser is now
    // the active overlay. Don't reopen the sidebar (that would replace the
    // chooser via overlay history and defeat the test).
    // The sidebar Context button is gone entirely; the header entry hides while
    // the chooser is open (same gate as the old draft: !chooserOpen).
    await expect(page.getByTestId("session-chooser")).toBeVisible();
    await expect(page.getByTestId("sidebar-context")).toHaveCount(0);
    await expect(page.getByTestId("context-open")).toHaveCount(0);
    await expect(page.getByTestId("settings-toggle")).toBeVisible();

    // --- close chooser, reopen sidebar, open settings panel ---
    await page.goBack();
    await openSidebar(page);
    await settings.click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
  });

  // Journey: open Settings → notifications and verify the connection row shows
  // the agent connection status and live tier.
  test("connection details remain available in Settings", async ({ page }) => {
    await openSettings(page, "notifications");
    const connection = page.getByTestId("connection-settings-row");
    await expect(connection).toContainText("Agent connection");
    await expect(connection).toContainText("Connected");
    await expect(connection).toContainText("Live");
  });

  // Journey: boot with a broken WebSocket and verify the header shows a
  // degraded connection status and a Reconnect button instead of failing silently.
  // (Special boot: custom WebSocket mock installed before navigation.)
  test("a degraded connection becomes visible instead of failing silently", async ({
    page,
  }) => {
    await page.request.get("/debug/reset");
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      class ClosedSocket {
        binaryType: BinaryType = "blob";
        bufferedAmount = 0;
        extensions = "";
        onclose: ((event: CloseEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onopen: ((event: Event) => void) | null = null;
        protocol = "";
        readyState: 0 | 1 | 2 | 3 = NativeWebSocket.CONNECTING;
        url = "ws://pantoken-unavailable";
        constructor() {
          window.setTimeout(() => {
            this.readyState = NativeWebSocket.CLOSED;
            this.onclose?.(new CloseEvent("close"));
          }, 0);
        }
        addEventListener() {}
        removeEventListener() {}
        dispatchEvent() {
          return true;
        }
        close() {
          this.readyState = NativeWebSocket.CLOSED;
        }
        send() {}
      }
      Object.assign(ClosedSocket, {
        CONNECTING: NativeWebSocket.CONNECTING,
        OPEN: NativeWebSocket.OPEN,
        CLOSING: NativeWebSocket.CLOSING,
        CLOSED: NativeWebSocket.CLOSED,
      });
      window.WebSocket = ClosedSocket as unknown as typeof WebSocket;
    });
    await page.goto("/?dev");
    const status = page.locator("header.hdr .conn");
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status).not.toHaveClass(/connected/);
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });
});

// ── Edge swipe ───────────────────────────────────────────────────────────────

test.describe("Edge swipe", () => {
  // Journey: swipe in from the left edge past the threshold to open the drawer,
  // close it, then verify a short swipe and an off-edge touch do not open it.
  // The left-edge swipe is touch-only — the universal mobile "open the drawer"
  // gesture. The swipe surface is the main pane (.app); the phone drawer slides
  // in from off-screen, so we assert on `data-open` rather than visibility.
  test("edge swipe opens the drawer; short and off-edge swipes do not", async ({
    page,
  }) => {
    const sidebar = page.getByTestId("sidebar");

    // --- past the threshold: drawer opens ---
    await expect(sidebar).toHaveAttribute("data-open", "false");
    await swipeFromLeftEdge(page, ".app", 160); // 160px → past the 88px threshold
    await expect(sidebar).toHaveAttribute("data-open", "true");

    // Close the drawer before testing the negative cases.
    await page.goBack();
    await expect(sidebar).toHaveAttribute("data-open", "false");

    // --- below the threshold: drawer stays closed ---
    await swipeFromLeftEdge(page, ".app", 50); // 50px → below the 88px threshold
    await expect(sidebar).toHaveAttribute("data-open", "false");

    // --- touch starting outside the edge strip: drawer stays closed ---
    await expect(sidebar).toHaveAttribute("data-open", "false");
    // Begin the touch well past the 24px edge strip, then drag rightward across the screen.
    await page.evaluate(() => {
      const el = document.querySelector(".app") as HTMLElement;
      const startX = 120; // outside the edge strip
      const touch = (clientX: number) =>
        new Touch({ identifier: 1, target: el, clientX, clientY: 200 });
      const fire = (type: string, clientX: number, moving: boolean) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: moving ? [touch(clientX)] : [],
            changedTouches: [touch(clientX)],
          }),
        );
      fire("touchstart", startX, true);
      fire("touchmove", startX + 80, true);
      fire("touchmove", startX + 160, true);
      fire("touchend", startX + 160, false);
    });
    await expect(sidebar).toHaveAttribute("data-open", "false");
  });
});

// ── Pull to refresh ──────────────────────────────────────────────────────────

test.describe("Pull to refresh", () => {
  // Journey: disconnect the transport, pull down past the threshold to trigger a
  // reconnect, then disconnect again and pull short to verify no refresh fires.
  // Pull-to-refresh is touch-only — the universal mobile "I think this is stale"
  // gesture; desktop has Reconnect (Alt+R).
  test("pull-to-refresh reconnects past the threshold and stays offline below it", async ({
    page,
  }) => {
    // --- past the threshold: forces a reconnect + re-snapshot ---
    // Drop the transport without taking Vite offline (same hook the delivery specs use);
    // the offline banner is our connected/offline probe.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("pantoken:test-disconnect")),
    );
    await expect(offline(page)).toBeVisible();

    await pullDown(page, ".scroller", 220); // ~110px → past the 64px threshold

    // The refreshing spinner shows on the transcript surface...
    await expect(page.getByTestId("ptr-transcript")).toHaveAttribute(
      "data-phase",
      "refreshing",
    );
    // ...and the socket comes back: the offline banner clears.
    await expect(offline(page)).toBeHidden();
    // The spinner settles once reconnected (min-visible floor, then clears).
    await expect(page.getByTestId("ptr-transcript")).toBeHidden({
      timeout: 5000,
    });

    // --- below the threshold: no refresh, still offline ---
    await page.evaluate(() =>
      window.dispatchEvent(new Event("pantoken:test-disconnect")),
    );
    await expect(offline(page)).toBeVisible();

    await pullDown(page, ".scroller", 60); // ~30px → below the threshold

    // No refresh fired: indicator stays hidden and we're still offline.
    await expect(page.getByTestId("ptr-transcript")).toBeHidden();
    await expect(offline(page)).toBeVisible();
  });
});

// ── Responsive content ───────────────────────────────────────────────────────

test.describe("Responsive content", () => {
  // Journey: drive a confirm approval and verify the sheet is reachable and
  // tappable on mobile, with the Allow button in the viewport.
  test("approval sheet is reachable and tappable on mobile", async ({ page }) => {
    await drive(page, "confirm");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Run destructive command?")).toBeVisible();
    const allow = dialog.getByRole("button", { name: "Allow" });
    await expect(allow).toBeInViewport();
    await allow.click();
    await expect(page.getByText("Approved — continuing.")).toBeVisible();
  });

  // Journey: drive a markdown turn and verify a wide table scrolls
  // horizontally instead of overflowing the page on mobile.
  test("a wide markdown table scrolls horizontally instead of overflowing", async ({
    page,
  }) => {
    await drive(page, "markdown");
    const md = page.locator(".markstream-svelte.markdown-renderer").last();
    // The fixture renders a narrow table, then a 7-column "wide table", then a code
    // block. Wait for the code block (last in the stream) so the whole turn — and the
    // wide table — has finished streaming before we measure.
    await expect(md.locator("pre", { hasText: "function greet" })).toBeVisible();

    // Select the wide table by a header unique to it (not `.last()`, which would race
    // the stream — the narrow table renders first).
    const wide = md.locator("table", { hasText: "CallingCode" });
    await expect(wide).toBeVisible();
    // The row carries `content-visibility: auto`; an off-screen row isn't laid out,
    // so measure only after scrolling it on-screen (a plain assertion won't scroll).
    await wide.scrollIntoViewIfNeeded();
    const metrics = await wide.evaluate((t) => ({
      overflowX: getComputedStyle(t).overflowX,
      // content is wider than the box → it's an actual horizontal scroll container
      scrolls: t.scrollWidth > t.clientWidth + 1,
      // the element itself stays within the viewport (no page-level overflow)
      rightWithinViewport:
        t.getBoundingClientRect().right <= window.innerWidth + 1,
      noPageOverflow:
        document.documentElement.scrollWidth <= window.innerWidth + 1,
    }));
    expect(metrics.overflowX).toBe("auto");
    expect(metrics.scrolls).toBe(true);
    expect(metrics.rightWithinViewport).toBe(true);
    expect(metrics.noPageOverflow).toBe(true);
  });

  // Journey: drive a markdown turn and verify a long code-line tail scrolls
  // clear of the 44px copy control.
  test("a long code-line tail scrolls clear of the 44px copy control", async ({
    page,
  }) => {
    await drive(page, "markdown");
    const md = page.locator(".markstream-svelte.markdown-renderer").last();
    await expect(md.locator("pre", { hasText: "function greet" })).toBeVisible();

    const wrap = md.locator(".code-block");
    const pre = wrap.locator("pre");
    const copy = wrap.getByRole("button", { name: "Copy code" });
    await expect(copy).toBeVisible();
    const copyBox = await copy.boundingBox();
    expect(copyBox).not.toBeNull();
    expect(copyBox!.width).toBeGreaterThanOrEqual(44);
    expect(copyBox!.height).toBeGreaterThanOrEqual(44);

    await pre.locator("code").evaluate((code) => {
      code.textContent = "start-" + "x".repeat(180);
      const marker = document.createElement("span");
      marker.dataset.testid = "long-line-tail";
      marker.textContent = "-TAIL";
      code.append(marker);
    });
    await pre.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const tailLocator = pre.getByTestId("long-line-tail");
    await expect(tailLocator).toBeInViewport();
    const tailBox = await tailLocator.boundingBox();
    const finalCopyBox = await copy.boundingBox();
    expect(tailBox).not.toBeNull();
    expect(finalCopyBox).not.toBeNull();
    // The marker deliberately lives on the first line, in the copy control's vertical
    // band. At maximum horizontal scroll its right edge must land left of the overlay.
    expect(tailBox!.y).toBeLessThan(finalCopyBox!.y + finalCopyBox!.height);
    expect(tailBox!.y + tailBox!.height).toBeGreaterThan(finalCopyBox!.y);
    expect(tailBox!.x + tailBox!.width).toBeLessThanOrEqual(finalCopyBox!.x - 1);
  });

  // Journey: open the sidebar search and verify the input font-size is >=16px
  // on touch, guarding against iOS Safari's auto-zoom on focus.
  test("text inputs render at >=16px on touch (guards against iOS focus-zoom)", async ({
    page,
  }) => {
    // iOS Safari auto-zooms the page when you focus a form control whose font-size is
    // < 16px, and won't zoom back out. The global `@media (pointer: coarse)` rule forces
    // every input to 16px. Assert it actually reaches a real input — the sidebar search,
    // which is 13px on desktop — under this hasTouch (pointer: coarse) project.
    await openSidebar(page);
    // The search input is behind a toggle — click it to reveal the input
    await page.getByTestId("sidebar-search-toggle").click();
    const search = page.getByRole("textbox", { name: "Search sessions" });
    await expect(search).toBeVisible();
    const fontSize = await search.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    );
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  // Journey: verify user and assistant message footers are ordered (button
  // first, time last), visible, and touch-safe on mobile.
  test("user and assistant footers are ordered, visible, and touch-safe", async ({
    page,
  }) => {
    for (const footer of [
      page.locator(".row.user .umeta").first(),
      page.locator(".row.assistant .meta").last(),
    ]) {
      await expect(footer).toHaveCSS("opacity", "1");
      await expect(footer).toHaveCSS("pointer-events", "auto");
      const tags = await footer
        .locator(":scope > *")
        .evaluateAll((nodes) => nodes.map((node) => node.tagName.toLowerCase()));
      expect(tags[0]).toBe("button");
      expect(tags.at(-1)).toBe("time");
      for (const action of await footer.locator("button").all()) {
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        await expect(action).toBeEnabled();
      }
    }
  });
});
