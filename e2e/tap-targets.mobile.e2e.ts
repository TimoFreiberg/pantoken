import { expect, type Locator, test } from "@playwright/test";
import {
  drive,
  gotoFresh,
  openSettings,
  openSidebar,
} from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

// Runs under the "mobile" project (Pixel 7 → coarse pointer + touch).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function expectTall(loc: Locator, min = 44) {
  const box = await loc.boundingBox();
  expect(box, "element should be laid out").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(min);
}

// Journey: drive a confirm dialog and verify Allow/Deny buttons meet the 44px
// touch target, then drive a selectmany dialog and verify its radio options do.
test("dialog actions and select options meet the 44px touch target", async ({
  page,
}) => {
  await drive(page, "confirm");
  const confirmDialog = page.getByRole("dialog");
  await expectTall(confirmDialog.getByRole("button", { name: "Allow" }));
  await expectTall(confirmDialog.getByRole("button", { name: "Deny" }));

  // Dismiss the confirm dialog before driving the next one.
  await confirmDialog.getByRole("button", { name: "Deny" }).click();

  await drive(page, "selectmany");
  const options = page.getByRole("dialog").getByRole("radio");
  await expect(options).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expectTall(options.nth(i));
});

// Journey: verify the mobile header and sidebar destinations, settings tabs,
// and sidebar navigation rows all meet the 44px touch target.
test("navigation UI meets the 44px touch target", async ({ page }) => {
  // Sessions is always the compact header entry. Context is a header entry,
  // always visible (the sidebar footer no longer carries a Context button).
  await expectTall(page.getByTestId("sidebar-open"));
  await expectTall(page.getByTestId("context-open"));
  await openSidebar(page);
  await expectTall(page.getByTestId("settings-toggle"));

  // Settings navigation tabs and the Back button.
  await openSettings(page);
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  for (const id of ["appearance", "models", "environment", "token"])
    await expectTall(page.getByTestId(`settings-tab-${id}`));
  await page.getByTestId("settings-tab-appearance").click();
  await expectTall(page.getByRole("button", { name: "Back to Settings" }));

  // Close settings and verify sidebar navigation rows.
  // From the appearance subsection, Escape returns to the settings index,
  // then a second Escape closes the panel entirely (mobile settings nav).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-panel")).toBeHidden();
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  await expectTall(sidebar.locator(".new-btn"));
  await expectTall(sidebar.locator(".group-toggle").first());
  await expectTall(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Wire up the WebSocket" })
      .locator(".row"),
  );
});

// Journey: verify the composer controls (attach, send, controls trigger) are
// labeled and touch-safe, attach an image to check preview/remove buttons, then
// drive a streaming turn to check the stop button.
test("composer controls are labeled and touch-safe, with a streaming stop", async ({
  page,
}) => {
  const controls = [
    page.getByRole("button", { name: "Attach images" }),
    // The idle+empty composer labels this "Send" (issue #74 removed the old
    // "Send empty prompt to continue" continue-signal affordance). The
    // `button.send` class is the stable hook; the test asserts the aria-label
    // is any non-empty string.
    page.locator("button.send"),
    page.getByTestId("mobile-session-controls-trigger"),
  ];
  for (const control of controls) {
    await expect(control).toHaveAttribute("aria-label", /.+/);
    await expectTall(control);
  }

  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "touch-target.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  const preview = page.getByRole("button", {
    name: "Preview attachment 1 full screen",
  });
  const remove = page.getByRole("button", { name: "Remove attachment 1" });
  await expectTall(preview);
  await expectTall(remove);
  await expect(preview).toHaveAttribute("aria-label", /Preview attachment/);
  await expect(remove).toHaveAttribute("aria-label", /Remove attachment/);

  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();
  await expectTall(stop);
  await expect(stop).toHaveAttribute("title", /Stop/);
});

// Journey: drive a streaming turn plus a queue, then verify the queue tray
// steer and restore buttons meet the 44px touch target and have tooltips.
test("queue tray steer and edit buttons meet the 44px touch target and have tooltips", async ({
  page,
}) => {
  await drive(page, "streamhold");
  await drive(page, "queue");
  const tray = page.getByTestId("queue-tray");

  const steer = tray.getByTestId("steer-button");
  await expectTall(steer);
  await expect(steer).toHaveAttribute("title", /.+/);
  await expect(steer).toHaveAttribute("aria-label", /.+/);

  const restore = tray.getByRole("button", {
    name: "Restore all queued messages to the composer",
  });
  await expectTall(restore);
  await expect(restore).toHaveAttribute("title", /.+/);
  await expect(restore).toHaveAttribute("aria-label", /.+/);
});
