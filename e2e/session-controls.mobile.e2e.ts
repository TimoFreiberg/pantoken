import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => gotoFresh(page));

test("the footer is one touch-safe button with all four current values", async ({
  page,
}) => {
  const trigger = page.getByTestId("mobile-session-controls-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAccessibleName(
    /Session controls: Standard, Execute, Claude Opus 4\.8, medium/,
  );
  await expect(trigger.locator("span")).toHaveCount(4);
  await expect(trigger.locator("span").nth(0)).toHaveText("Standard");
  await expect(trigger.locator("span").nth(1)).toHaveText("Execute");
  await expect(trigger.locator("span").nth(2)).toHaveText("Claude Opus 4.8");
  await expect(trigger.locator("span").nth(3)).toHaveText("medium");
  const box = await trigger.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("permission-badge")).toBeHidden();
  await expect(page.getByTestId("facet-badge")).toBeHidden();
  await expect(page.getByTestId("model-badge")).toBeHidden();
});

test("changing controls updates the summary and Back does not summon the composer", async ({
  page,
}) => {
  const trigger = page.getByTestId("mobile-session-controls-trigger");
  const composer = page.getByPlaceholder("Message pantoken…");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Session controls" });
  await expect(dialog).toBeVisible();
  const back = dialog.getByRole("button", { name: "Back" });
  expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await dialog.getByRole("radio", { name: /Plan/ }).check();
  await back.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toContainText("Plan");
  await expect(composer).not.toBeFocused();
});

test("model search, model selection, and thinking update the mobile summary", async ({
  page,
}) => {
  const trigger = page.getByTestId("mobile-session-controls-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Session controls" });
  const search = dialog.getByRole("searchbox", { name: "Search models" });
  await search.fill("sonnet");
  await expect(dialog.getByRole("radio", { name: /Claude Sonnet 4\.6/ })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Claude Opus 4\.8/ })).toBeHidden();
  await dialog.getByRole("radio", { name: /Claude Sonnet 4\.6/ }).check();
  await dialog.getByRole("radio", { name: "High" }).check();
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(trigger).toContainText("Claude Sonnet 4.6");
  await expect(trigger).toContainText("high");
  // The thinking-level radio sends a standalone setThinking action,
  // which emits an info notice in the transcript (last notice = most recent).
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Thinking level set to high",
  );
});

test("context actions require two taps in the mobile controls", async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
      "contextfull",
    ),
  );
  await page.getByTestId("mobile-session-controls-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Session controls" });
  const compact = dialog.getByRole("button", { name: "Compact context" });
  await compact.click();
  await expect(dialog.getByText("91% of the context window used")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tap again to compact" })).toBeVisible();
  await dialog.getByRole("button", { name: "Tap again to compact" }).click();
  await expect(dialog.getByText("4% of the context window used")).toBeVisible();

  await page.evaluate(() =>
    (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
      "contextfull",
    ),
  );
  const clear = dialog.getByRole("button", { name: "Clear context" });
  await clear.click();
  await expect(dialog.getByText("91% of the context window used")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tap again to clear" })).toBeVisible();
  await dialog.getByRole("button", { name: "Tap again to clear" }).click();
  await expect(dialog.getByText("0% of the context window used")).toBeVisible();
});

test("browser Back closes the full-screen controls without leaving the app", async ({
  page,
}) => {
  await page.getByTestId("mobile-session-controls-trigger").click();
  await expect(page.getByRole("dialog", { name: "Session controls" })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(
    page.getByRole("dialog", { name: "Session controls" }),
  ).toBeHidden();
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();
});

test("replacing the composer consumes an open controls history entry", async ({
  page,
}) => {
  await page.getByTestId("mobile-session-controls-trigger").click();
  await expect(
    page.getByRole("dialog", { name: "Session controls" }),
  ).toBeVisible();

  await page.keyboard.press("Control+n");
  // ⌘N opens the chooser, which replaces the session-controls overlay via
  // overlay history (peer navigation reuses one root history entry).
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Session controls" })).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (history.state as { pantokenOverlay?: string } | null)
            ?.pantokenOverlay ?? null,
      ),
    )
    .toBe("session-chooser");
});

test("crossing to desktop closes controls without changing desktop composer chrome", async ({
  page,
}) => {
  await page.getByTestId("mobile-session-controls-trigger").click();
  await expect(page.getByRole("dialog", { name: "Session controls" })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 850 });
  await expect(page.getByRole("dialog", { name: "Session controls" })).toBeHidden();
  await expect(page.getByTestId("mobile-session-controls-trigger")).toBeHidden();
  await expect(page.getByTestId("permission-badge")).toBeVisible();
  await expect(page.getByTestId("model-badge")).toBeVisible();
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.getByRole("dialog", { name: "Session controls" })).toBeHidden();
});

test("draft text and attachment survive opening, changes, and closing", async ({
  page,
}) => {
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("Keep this exact draft");
  await page.locator('input[type="file"]').setInputFiles({
    name: "keep.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await page.getByTestId("mobile-session-controls-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Session controls" });
  await dialog
    .getByRole("radio", { name: /Bypass/ })
    .first()
    .check();
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(composer).toHaveValue("Keep this exact draft");
  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  await expect(
    page.getByTestId("mobile-session-controls-trigger"),
  ).toContainText("Bypass");
});
