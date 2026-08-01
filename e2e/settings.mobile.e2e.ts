import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSettings, openSidebar } from "./helpers.js";

// Flow tests for the mobile settings surface and adjacent phone UI: the
// settings panel (index/detail navigation, token management, background model,
// history/breakpoint, scrolling), the host switcher, and the session-chooser
// project list. Absorbed files: host-switcher.mobile.e2e.ts,
// project-menu.mobile.e2e.ts.

test.use({ viewport: { width: 390, height: 600 } });

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// ---------------------------------------------------------------------------
// Settings panel flows
// ---------------------------------------------------------------------------

// Mobile Settings opens as a full-screen section index, detail navigation
// follows Back and Escape hierarchy, and desktop section shortcuts do not
// navigate mobile Settings.
test("mobile Settings opens as full-screen index, navigates detail/index hierarchy, and ignores desktop shortcuts", async ({
  page,
}) => {
  // --- Index view: full-screen, touch-safe, focus cycle ---
  await openSettings(page);
  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  const box = await panel.boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 390, height: 600 });
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  for (const section of [
    "appearance",
    "notifications",
    "models",
    "environment",
    "mcp",
    "token",
    "computers",
  ]) {
    const row = panel.getByTestId(`settings-tab-${section}`);
    await expect(row).toBeVisible();
    expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: "Close settings" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByTestId("settings-tab-computers")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: "Close settings" }),
  ).toBeFocused();

  // Close the index, then reopen to a detail for the navigation hierarchy.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // --- Detail navigation: Back and Escape hierarchy ---
  await openSettings(page, "appearance");
  await expect(
    panel.getByRole("heading", { name: "Appearance" }),
  ).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByTestId("theme-system")).toBeVisible();
  await expect(panel.getByTestId("settings-index")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  await panel.getByTestId("settings-tab-environment").click();
  await expect(
    panel.getByRole("heading", { name: "Environment" }),
  ).toBeVisible();
  await expect(panel).toBeFocused();
  await panel.getByRole("button", { name: "Back to Settings" }).click();
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  await expect(panel).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".composer-surface textarea")).toBeFocused();

  // --- Desktop shortcuts do not navigate mobile Settings ---
  await openSettings(page);
  await page.keyboard.press("Alt+2");
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Notifications" }),
  ).toHaveCount(0);

  await panel.getByTestId("settings-tab-appearance").click();
  await page.keyboard.press("Alt+2");
  await expect(
    panel.getByRole("heading", { name: "Appearance" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Notifications" }),
  ).toHaveCount(0);
});

// Saving an access token keeps the visible detail in history.
test("saving an access token keeps the visible detail in history", async ({
  page,
}) => {
  await openSettings(page, "token");
  const panel = page.getByTestId("settings-panel");
  await panel.getByPlaceholder("Enter token…").fill("local-test-token");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(
    panel.getByRole("heading", { name: "Access token" }),
  ).toBeVisible();

  await page.goBack();
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  await page.goBack();
  await expect(panel).toHaveCount(0);
});

// Forgetting a token consumes Settings history before showing the gate.
test("forgetting a token consumes Settings history before showing the gate", async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem("pantoken_token", "saved-token"),
  );
  await page.reload();
  await expect(page.getByTestId("work-toggle")).toBeVisible();
  await openSettings(page, "token");
  await page.getByRole("button", { name: "Forget" }).click();

  await expect(page.getByPlaceholder("Access token")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (history.state as { pantokenOverlay?: string } | null)
            ?.pantokenOverlay ?? null,
      ),
    )
    .toBeNull();
});

// An invalid legacy background model remains visible without an editor.
test("an invalid legacy background model remains visible without an editor", async ({
  page,
}) => {
  await openSettings(page, "models");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(`${protocol}//${location.host}/ws`);
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error("background model warning was not broadcast"));
        }, 5_000);
        socket.onopen = () => socket.send(JSON.stringify({ type: "hello" }));
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            backgroundModelWarning?: string;
          };
          if (message.type === "hello") {
            socket.send(
              JSON.stringify({
                type: "setBackgroundModel",
                spec: "anthropic/nope-9-9",
              }),
            );
          } else if (
            message.type === "pantokenSettings" &&
            message.backgroundModelWarning
          ) {
            window.clearTimeout(timeout);
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("warning WebSocket failed"));
      }),
  );

  await expect(page.getByTestId("background-model-warning")).toContainText(
    "Background model configuration is invalid",
  );
  await expect(page.getByTestId("background-model-input")).toHaveCount(0);
});

// UI closes consume nested history before the next open.
test("UI closes consume nested history before the next open", async ({
  page,
}) => {
  const url = page.url();
  await openSettings(page, "environment");
  const panel = page.getByTestId("settings-panel");

  await panel.getByRole("button", { name: "Back to Settings" }).click();
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  await panel.getByRole("button", { name: "Close settings" }).click();
  await expect(panel).toHaveCount(0);

  await openSettings(page);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(page.getByTestId("composer-surface")).toBeVisible();
});

// A phone-detail breakpoint round trip leaves one balanced overlay.
test("a phone-detail breakpoint round trip leaves one balanced overlay", async ({
  page,
}) => {
  await openSettings(page, "appearance");
  const panel = page.getByTestId("settings-panel");

  await page.setViewportSize({ width: 860, height: 700 });
  await expect(panel.getByRole("tab", { name: "Appearance" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    panel.getByRole("button", { name: "Back to Settings" }),
  ).toHaveCount(0);
  const desktopBox = await panel.boundingBox();
  expect(desktopBox?.width).toBeLessThan(860);
  expect(desktopBox?.height).toBeLessThan(700);

  await page.setViewportSize({ width: 859, height: 600 });
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  await expect
    .poll(async () => {
      const box = await panel.boundingBox();
      return (
        box && {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
      );
    })
    .toEqual({ x: 0, y: 0, width: 859, height: 600 });
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("composer-surface")).toBeVisible();
});

// Narrowing open desktop Settings creates one phone history entry.
test("narrowing open desktop Settings creates one phone history entry", async ({
  page,
}) => {
  const url = page.url();
  await page.setViewportSize({ width: 860, height: 700 });
  await openSettings(page);
  const panel = page.getByTestId("settings-panel");
  await expect(panel.getByRole("tab", { name: "Appearance" })).toBeVisible();

  // Desktop Settings opens without touching browser history (the panel is
  // docked, not a phone overlay). Narrowing to 859px reflows via CSS
  // synchronously — settings-index appears at once — but the matchMedia
  // `change` event that pushes the phone overlay history entry fires
  // asynchronously. Wait for that entry to land before Back, else goBack runs
  // before any overlay entry exists and exits the app to about:blank.
  const lenBeforeNarrow = await page.evaluate(() => history.length);
  await page.setViewportSize({ width: 859, height: 600 });
  await expect(panel.getByTestId("settings-index")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => history.length))
    .toBe(lenBeforeNarrow + 1);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(page.locator(".composer-surface textarea")).toBeFocused();
});

// Long detail content scrolls inside the safe full-screen surface.
test("long detail content scrolls inside the safe full-screen surface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await openSettings(page, "token");
  const body = page.getByTestId("settings-panel").locator(".body");
  await expect(page.getByTestId("data-dir-section")).toBeVisible();
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText("No token saved")).toBeVisible();
  const dimensions = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(dimensions.overflowY).toBe("auto");
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(dimensions.scrollTop).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Host switcher flows
// ---------------------------------------------------------------------------

// The phone host picker is a full-screen sheet with labeled touch-safe
// controls and focus stays within the sheet when tabbing.
test("phone host picker is a full-screen sheet with touch-safe controls and traps focus", async ({
  page,
}) => {
  await openSidebar(page);
  const trigger = page.getByTestId("host-switcher-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Choose computer" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.y).toBe(0);
  await expect(dialog.getByRole("button", { name: "Close computer picker" })).toHaveCSS("min-height", "44px");
  for (const option of await dialog.locator(".host-option").all()) {
    const optionBox = await option.boundingBox();
    expect(optionBox).not.toBeNull();
    expect(optionBox!.height).toBeGreaterThanOrEqual(44);
  }

  // Focus stays within the sheet when tabbing.
  const close = dialog.getByRole("button", { name: "Close computer picker" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  // The management buttons (Add remote host, Manage computers) are now enabled
  // and sit after the host options, so Shift+Tab from Close lands on the last
  // management button.
  await expect(dialog.getByTestId("manage-computers-btn")).toBeFocused();
});

// ---------------------------------------------------------------------------
// Project menu (session chooser) flows
// ---------------------------------------------------------------------------

// Under create-on-click (phase 3), the project-selection UI lives in the
// session chooser (SessionChooser.svelte). On mobile the chooser renders as a
// full-screen overlay — the same shape the old draft project menu had.

const chooser = (page: Page) => page.getByTestId("session-chooser");

async function openChooser(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();
}

// Mobile chooser is a full-screen overlay with touch targets, back gesture
// closes it, and selecting a project creates a session.
test("mobile chooser is a full-screen overlay with touch targets, back gesture, and creates a session on selection", async ({
  page,
}) => {
  await openChooser(page);
  // Wait for the reveal animation to settle before measuring bounding boxes.
  await page.waitForTimeout(200);

  // Full-screen overlay: covers the viewport.
  const chooserBox = await chooser(page).boundingBox();
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  expect(chooserBox).not.toBeNull();
  expect(chooserBox!.width).toBe(vw);
  expect(chooserBox!.height).toBe(vh);

  // Touch-safe targets: every result row is at least 44px tall.
  const rows = chooser(page).locator(".result");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await rows.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  // The search input is also touch-safe.
  const input = chooser(page).getByRole("textbox", {
    name: "Filter projects",
  });
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.height).toBeGreaterThanOrEqual(44);

  // Back gesture closes the chooser.
  await page.goBack();
  await expect(chooser(page)).toHaveCount(0);

  // Selecting a project from the chooser creates a session.
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();
  await chooser(page).getByTestId("chooser-project-scratch").click();
  await expect(chooser(page)).toHaveCount(0);
  // A new session row appears.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );
});
