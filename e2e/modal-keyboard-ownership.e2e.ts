import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSettings } from "./helpers.js";

// Regression for issue #62 — "Settings doesn't own the keyboard."
//
// While a user-driven modal is open (Settings, PlanView, ImageLightbox), every
// global app shortcut that fires from App.svelte's onGlobalKeydown and
// StatusHeader.svelte's onWindowKeydown must be suppressed, so no underlying
// state changes invisibly behind the scrim. The modal's own <svelte:window>
// listener (Escape, Alt+1..6, ⌘,) keeps working; zoom keys (⌘=/-/0) stay usable
// (they run onZoomKey, which fires before onGlobalKeydown and is never guarded).
//
// CI runs Chromium on Linux, where the app's hotkeys read Ctrl (the handlers
// accept metaKey || ctrlKey). Presses use "Control+…" to match the other specs —
// except ⌘P and ⌘F, which use "Meta+" to avoid triggering Chromium's native
// print/find-in-page dialogs (see e2e/plan-view.e2e.ts:41 for the Meta+p
// precedent).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const permissionBadge = (page: import("@playwright/test").Page) =>
  page.getByTestId("permission-badge");

test("⌘⇧P is suppressed while Settings is open", async ({ page }) => {
  // This is the exact repro from the issue body.
  await openSettings(page);
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(permissionBadge(page)).toContainText("Standard");

  // While Settings is open, ⌘⇧P must NOT cycle the permission mode.
  await page.keyboard.press("Control+Shift+P");
  await expect(permissionBadge(page)).toContainText("Standard");
  await expect(permissionBadge(page)).not.toContainText("Bypass");

  // Closing Settings — still Standard (no deferred side effect).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-panel")).toHaveCount(0);
  await expect(permissionBadge(page)).toContainText("Standard");
});

test("⌘⇧M does not open the model picker while Settings is open", async ({
  page,
}) => {
  await openSettings(page);
  await expect(page.getByTestId("settings-panel")).toBeVisible();

  // While Settings is open, ⌘⇧M must NOT open the picker.
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".mp .panel")).toHaveCount(0);

  // Closing Settings — picker still closed.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-panel")).toHaveCount(0);
  await expect(page.locator(".mp .panel")).toHaveCount(0);

  // Sanity: with no modal open, ⌘⇧M DOES open the picker — proving the guard is
  // specific to the modal, not a blanket breakage.
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".mp .panel")).toBeVisible();
});

test("⌘⇧J does not toggle the context panel while Settings is open", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  const before = await panel.getAttribute("data-open");

  await openSettings(page);
  await expect(page.getByTestId("settings-panel")).toBeVisible();

  // While Settings is open, ⌘⇧J must NOT toggle the right context panel.
  await page.keyboard.press("Control+Shift+J");

  // Closing Settings — the panel's open state must be unchanged.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-panel")).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-open", before ?? "");
});

// AC.4 — parametrize over the unshifted global shortcuts + Ctrl+Tab. Each must
// be inert while Settings is open. (⌘P uses Meta+ to avoid the native print
// dialog; it also needs an active plan seeded first or its handler is a no-op
// with or without the guard — see the dedicated ⌘P test below.)
test.describe("other global shortcuts are suppressed while Settings is open", () => {
  for (const [label, combo, assertInert] of [
    ["⌘B (sidebar)", "Control+b", assertSidebarUnchanged],
    ["⌘N (new-session draft)", "Control+n", assertNoDraft],
    ["⌘K (sidebar search)", "Control+k", assertNoSidebarSearch],
    ["⌘[ (back)", "Control+[", assertActiveSessionUnchanged],
    ["⌘] (forward)", "Control+]", assertActiveSessionUnchanged],
    ["Ctrl+Tab (cycle session)", "Control+Tab", assertActiveSessionUnchanged],
  ] as const) {
    test(`${label} is suppressed`, async ({ page }) => {
      await openSettings(page);
      await expect(page.getByTestId("settings-panel")).toBeVisible();
      await page.keyboard.press(combo);
      // Close Settings before asserting — the observable we care about is that
      // underlying state is unchanged once the modal is dismissed.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-panel")).toHaveCount(0);
      await assertInert(page);
    });
  }

  test("⌘F (find in transcript) is suppressed", async ({ page }) => {
    // ⌘F uses Meta+ to avoid Chromium's native find-in-page dialog.
    await openSettings(page);
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await page.keyboard.press("Meta+f");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    // The in-transcript find bar must not have opened.
    await expect(page.getByTestId("transcript-search")).toHaveCount(0);
  });

  test("⌘P (plan view) does not open a second modal behind Settings", async ({
    page,
  }) => {
    // The default greeting fixture has active_plan: None, which makes the ⌘P
    // handler (gated `if (!store.draft && store.session.activePlan)`) a no-op
    // with or without the guard — a vacuous test. Seed an active plan first
    // (BEFORE opening Settings, since the guard would suppress ⌘P otherwise).
    await drive(page, "planview");
    await expect(page.getByTestId("plan-view-toggle")).toBeVisible();

    await openSettings(page);
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    // ⌘P uses Meta+ to avoid the native print dialog.
    await page.keyboard.press("Meta+p");

    // Closing Settings — PlanView must NOT have opened behind the scrim.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await expect(page.getByTestId("plan-view")).toHaveCount(0);
  });
});

test("Settings' own shortcuts still work while it is open", async ({
  page,
}) => {
  // Guards against an over-broad guard that would also swallow Settings' own
  // keystrokes. Settings has its own <svelte:window> listener, so these fire
  // independently — but the test pins the contract.
  await openSettings(page);
  await expect(page.getByTestId("settings-panel")).toBeVisible();

  // Default section is "appearance". Cycle Alt+1..6 and assert the active tab
  // follows the rail order: appearance, notifications, models, environment,
  // mcp, token.
  const order = [
    "appearance",
    "notifications",
    "models",
    "environment",
    "mcp",
    "token",
  ] as const;
  for (let i = 0; i < order.length; i++) {
    await page.keyboard.press(`Alt+${i + 1}`);
    await expect(page.getByTestId(`settings-tab-${order[i]}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }

  // Escape closes Settings.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-panel")).toHaveCount(0);
});

test("⌘⇧P is suppressed while PlanView is open", async ({ page }) => {
  // AC.6 — the guard covers store.planViewOpen too, not just Settings.
  // Seed an active plan, open PlanView via the toggle button (a click, not a
  // hotkey — so the guard never intercepts the open itself), then press ⌘⇧P
  // and assert the permission mode is unchanged.
  await drive(page, "planview");
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();
  await page.getByTestId("plan-view-toggle").click();
  await expect(page.getByTestId("plan-view")).toBeVisible();

  await expect(permissionBadge(page)).toContainText("Standard");

  // While PlanView is open, ⌘⇧P must NOT cycle.
  await page.keyboard.press("Control+Shift+P");
  await expect(permissionBadge(page)).toContainText("Standard");
  await expect(permissionBadge(page)).not.toContainText("Bypass");

  // Escape closes PlanView — still Standard.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("plan-view")).toHaveCount(0);
  await expect(permissionBadge(page)).toContainText("Standard");
});

test("⌘P still closes PlanView while PlanView is open (toggle not suppressed)", async ({
  page,
}) => {
  // The modal guard suppresses shortcuts that change underlying state invisibly,
  // but ⌘P is PlanView's OWN toggle — its close affordance, equivalent to Escape.
  // Suppressing it would make PlanView only closeable via Escape/click, a
  // regression of the pre-fix ⌘P-toggles contract (e2e/plan-view.e2e.ts:36).
  // This test pins that ⌘P still closes PlanView while PlanView is the open modal.
  await drive(page, "planview");
  await expect(page.getByTestId("plan-view-toggle")).toBeVisible();
  await page.getByTestId("plan-view-toggle").click();
  await expect(page.getByTestId("plan-view")).toBeVisible();

  // ⌘P closes PlanView — the guard must NOT suppress PlanView's own toggle.
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toHaveCount(0);

  // And ⌘P re-opens it (no modal open now → guard doesn't apply).
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("plan-view")).toBeVisible();
});

test("⌘⇧P is suppressed while ImageLightbox is open", async ({ page }) => {
  // AC.6 sibling — the guard's `imageViewer.index !== null` branch. The guard
  // expression is identical to the Settings/PlanView branches (already tested
  // above), but this pins the ImageLightbox path explicitly so a future refactor
  // that touches the image-viewer singleton can't silently drop it.
  //
  // Seed the `images` fixture (a user-attached image + a tool-output image),
  // wait for the run to settle, then click the user attachment to open the
  // shared ImageLightbox.
  await drive(page, "images");
  // Wait for the images turn to finish (the runCompleted snapshot flips the
  // session back to Idle) and the user attachment to render.
  await expect(page.locator(".att-img-btn").first()).toBeVisible({ timeout: 10000 });

  const attBtn = page.locator(".att-img-btn").first();
  await attBtn.click();
  await expect(page.getByTestId("image-lightbox")).toBeVisible();

  await expect(permissionBadge(page)).toContainText("Standard");

  // While the lightbox is open, ⌘⇧P must NOT cycle.
  await page.keyboard.press("Control+Shift+P");
  await expect(permissionBadge(page)).toContainText("Standard");
  await expect(permissionBadge(page)).not.toContainText("Bypass");

  // Escape closes the lightbox — still Standard.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
  await expect(permissionBadge(page)).toContainText("Standard");
});

// --- Per-shortcut inertness assertions for AC.4's parametrized cases ---

async function assertSidebarUnchanged(page: import("@playwright/test").Page) {
  // Desktop default is open; ⌘B would have closed it.
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "true");
}

async function assertNoDraft(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("new-session")).toHaveCount(0);
}

async function assertNoSidebarSearch(page: import("@playwright/test").Page) {
  // ⌘K would have opened the sidebar search input.
  await expect(page.getByTestId("sidebar-search-input")).toHaveCount(0);
}

async function assertActiveSessionUnchanged(
  page: import("@playwright/test").Page,
) {
  // ⌘[/⌘]/Ctrl+Tab would have navigated away from the greeting session.
  await expect(page.locator("header .title")).toContainText(
    "Wire up the WebSocket bridge",
  );
}
