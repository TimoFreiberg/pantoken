import { expect, test, type Locator, type Page } from "@playwright/test";
import { closeOverlayAndWaitForOwnedPop, gotoFresh, openSidebar } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

async function expectTapTarget(locator: Locator, minimum = 44): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "control should have a layout box").not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
}

function sessionRow(page: Page, name: string): Locator {
  return page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: name });
}

// ── Sessions sidebar ────────────────────────────────────────────────────────

test.describe("Sessions sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
    await openSidebar(page);
  });

  // Journey: verify the mobile sessions sidebar top bar has touch-safe controls
  // and that session rows stay flat (no card outlines).
  test("Sessions sidebar has a touch-safe top bar and flat list rows", async ({
    page,
  }) => {
    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar.getByRole("heading", { name: "Sessions" })).toBeVisible();

    await expectTapTarget(
      sidebar.getByRole("button", { name: "Close sessions" }),
    );
    await expectTapTarget(sidebar.getByTestId("sidebar-search-toggle"));
    await expectTapTarget(sidebar.getByTestId("filter-toggle"));
    await expectTapTarget(
      sidebar.getByTestId("sidebar-new-session").locator(".new-btn"),
      48,
    );

    const project = sidebar
      .locator(".group")
      .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
    await expectTapTarget(project.locator(".group-toggle"));
    await expectTapTarget(
      project.getByRole("button", { name: "New session in pantoken" }),
    );

    const line = sessionRow(page, "Explore the fold reducer");
    await expectTapTarget(line.locator("button.row"), 48);
    await expectTapTarget(line.getByTestId("session-menu"));

    // Phone session rows stay flat: selection/hover may tint a row, but does not
    // introduce an individual card outline.
    const inactive = line.locator("button.row");
    await expect(inactive).toHaveCSS("border-top-width", "0px");
    await expect(inactive).toHaveCSS("border-right-width", "0px");
    await expect(inactive).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("mobile disclosure is accessible and touch-safe", async ({ page }) => {
    const sidebar = page.getByTestId("sidebar");
    await page.evaluate(() =>
      (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
        "manysessions",
      ),
    );
    await closeOverlayAndWaitForOwnedPop(page, {
      overlayId: "sessions",
      close: () => sidebar.getByRole("button", { name: "Close sessions" }).click(),
      closed: () => expect(sidebar).toHaveAttribute("data-open", "false"),
    });
    await openSidebar(page);

    const group = sidebar
      .locator(".group")
      .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
    const disclosure = group.getByTestId("show-more-sessions");
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toHaveAccessibleName("Show more sessions in pantoken");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expectTapTarget(disclosure);
    await expect(disclosure).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(disclosure).toHaveCSS("border-top-style", "none");

    await disclosure.tap();
    await expect(group.locator("[data-testid='session-status']")).toHaveCount(8);
    await expect(group.getByTestId("show-less-sessions")).toHaveAccessibleName(
      "Show less sessions in pantoken",
    );
    await expect(group.getByTestId("show-less-sessions")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("mobile close/reopen resets incremental expansion", async ({ page }) => {
    const sidebar = page.getByTestId("sidebar");
    await page.evaluate(() =>
      (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
        "manysessions",
      ),
    );
    await closeOverlayAndWaitForOwnedPop(page, {
      overlayId: "sessions",
      close: () => sidebar.getByRole("button", { name: "Close sessions" }).click(),
      closed: () => expect(sidebar).toHaveAttribute("data-open", "false"),
    });
    await openSidebar(page);

    const group = sidebar
      .locator(".group")
      .filter({ has: page.locator(".proj", { hasText: "pantoken" }) });
    await group.getByTestId("show-more-sessions").tap();
    await expect(group.locator("[data-testid='session-status']")).toHaveCount(8);

    // Phone close path uses the actual drawer control and is also history-backed.
    await closeOverlayAndWaitForOwnedPop(page, {
      overlayId: "sessions",
      close: () => sidebar.getByRole("button", { name: "Close sessions" }).click(),
      closed: () => expect(sidebar).toHaveAttribute("data-open", "false"),
    });
    await openSidebar(page);

    await expect(group.locator("[data-testid='session-status']")).toHaveCount(5);
    await expect(group.getByTestId("show-more-sessions")).toContainText("Show 3 more");
  });

  // Journey: open sessions search, verify it fills the top bar, filter results,
  // then use Back to close search before closing Sessions.
  test("search uses the full top bar and Back closes search before Sessions", async ({
    page,
  }) => {
    const sidebar = page.getByTestId("sidebar");
    await sidebar.getByTestId("sidebar-search-toggle").click();
    const search = sidebar.getByRole("textbox", { name: "Search sessions" });
    await expect(search).toBeVisible();

    const searchBox = await search.boundingBox();
    const sidebarBox = await sidebar.boundingBox();
    expect(searchBox!.width).toBeGreaterThan(sidebarBox!.width - 80);
    await search.fill("fold reducer");
    await expect(sidebar.getByText("quick scratch session")).toHaveCount(0);

    await page.goBack();
    await expect(search).toBeHidden();
    await expect(sidebar).toHaveAttribute("data-open", "true");
    await expect(sidebar.getByText("quick scratch session")).toBeVisible();

    await sidebar.getByTestId("sidebar-search-toggle").click();
    await sidebar.getByTestId("sidebar-search-close").click();
    await expect(search).toBeHidden();
    await expect(sidebar).toHaveAttribute("data-open", "true");
    await page.goBack();
    await expect(sidebar).toHaveAttribute("data-open", "false");
  });

  // Journey: open the session action sheet, verify its buttons/focus/touch
  // targets, navigate with Cancel and Back, then perform copy-ID, rename, and
  // archive actions without selecting the row.
  test("session action sheet opens, navigates, and performs copy, rename, and archive", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sidebar = page.getByTestId("sidebar");
    const overflow = sessionRow(page, "Explore the fold reducer").getByTestId(
      "session-menu",
    );

    // --- sheet navigation (open, verify, Cancel, Back) ---
    await expect(overflow).toHaveAttribute("aria-haspopup", "dialog");
    await overflow.click();
    const sheet = page.getByRole("dialog", { name: "Session actions" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeVisible();
    const firstAction = sheet.getByRole("button", { name: "Copy session ID" });
    await expect(firstAction).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(firstAction).toBeFocused();
    for (const action of [
      "Copy session ID",
      "Rename",
      "Reload session",
      "Detach session",
      "Archive",
      "Cancel",
    ]) {
      await expectTapTarget(
        sheet.getByRole("button", { name: action, exact: true }),
        48,
      );
    }

    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await expect(sidebar).toHaveAttribute("data-open", "true");
    await expect(overflow).toBeFocused();
    await page.goBack();
    await expect(sidebar).toHaveAttribute("data-open", "false");

    await openSidebar(page);
    await overflow.click();
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(sidebar).toHaveAttribute("data-open", "true");
    await expect(overflow).toBeFocused();
    await page.goBack();
    await expect(sidebar).toHaveAttribute("data-open", "false");

    // --- sheet actions: copy, rename, archive ---
    await openSidebar(page);
    const row = sessionRow(page, "Explore the fold reducer");
    const activeBefore = await sidebar.locator("button.row.active").textContent();

    await row.getByTestId("session-menu").click();
    await page
      .getByRole("dialog", { name: "Session actions" })
      .getByRole("button", { name: "Copy session ID" })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "older-session",
    );
    await expect(sidebar).toHaveAttribute("data-open", "true");

    await row.getByTestId("session-menu").click();
    await page
      .getByRole("dialog", { name: "Session actions" })
      .getByRole("button", { name: "Rename", exact: true })
      .click();
    const rename = sidebar.getByRole("textbox", { name: "New session name" });
    await rename.fill("Fold reducer on phone");
    await sidebar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sidebar.getByText("Fold reducer on phone")).toBeVisible();
    await expect(sidebar.locator("button.row.active")).toContainText(
      activeBefore!.trim(),
    );

    const renamed = sessionRow(page, "Fold reducer on phone");
    await renamed.getByTestId("session-menu").click();
    await page
      .getByRole("dialog", { name: "Session actions" })
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    await expect(renamed).toHaveCount(0);
    await expect(
      sidebar.getByTestId("toast").filter({ hasText: "Archived" }),
    ).toBeVisible();
  });

  // Journey: toggle the filter, reload to verify it persists, then select a
  // session and confirm it closes the sidebar and updates the header title.
  test("selecting a session closes Sessions and the filter preference persists", async ({
    page,
  }) => {
    const sidebar = page.getByTestId("sidebar");
    const filter = sidebar.getByTestId("filter-toggle");
    await filter.click();
    await expect(filter).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await openSidebar(page);
    await expect(sidebar.getByTestId("filter-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await sidebar.getByText("Explore the fold reducer").click();
    await expect(sidebar).toHaveAttribute("data-open", "false");
    await expect(page.locator("header .title")).toContainText(
      "Explore the fold reducer",
    );
  });
});

// ── Session controls ────────────────────────────────────────────────────────

test.describe("Session controls", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
  });

  // Journey: verify the mobile session controls footer summary, then open the
  // dialog to change the plan mode, search and select a different model, and
  // set the thinking level — checking the summary updates after each change.
  test("verify and adjust mobile session controls: summary, plan, model, and thinking", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const trigger = page.getByTestId("mobile-session-controls-trigger");
    const composer = page.getByPlaceholder("Message pantoken…");

    // --- initial summary (footer is one touch-safe button, four values) ---
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

    // --- change plan mode; Back does not summon the composer ---
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

    // --- model search, model selection, and thinking ---
    await trigger.click();
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

  // Journey: open the mobile controls, drive the context to full, then verify
  // that compact and clear each require a second confirming tap.
  test("context compact and clear require two taps in the mobile controls", async ({
    page,
  }) => {
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

  // Journey: open the controls overlay, close it with browser Back, reopen it,
  // then replace it with the new-session chooser via ⌘N — verifying overlay
  // history management on mobile.
  test("browser Back and ⌘N close or replace the full-screen controls overlay", async ({
    page,
  }) => {
    await page.getByTestId("mobile-session-controls-trigger").click();
    await expect(page.getByRole("dialog", { name: "Session controls" })).toBeVisible();
    await page.evaluate(() => history.back());
    await expect(
      page.getByRole("dialog", { name: "Session controls" }),
    ).toBeHidden();
    await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();

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

  // Journey: open the mobile controls, resize to desktop, verify the controls
  // close and desktop composer chrome appears, then resize back to mobile.
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
    // Dismiss the controls overlay via browser Back before resizing back to
    // mobile, so the dialog doesn't reappear when the mobile layout restores.
    await page.evaluate(() => history.back());
    await page.setViewportSize({ width: 412, height: 915 });
    await expect(page.getByRole("dialog", { name: "Session controls" })).toBeHidden();
  });

  // Journey: fill draft text and attach an image, open the controls dialog,
  // change a setting, close it, and verify the draft and attachment survived.
  test("draft text and attachment survive opening, changes, and closing controls", async ({
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
});

// ── New session chooser ─────────────────────────────────────────────────────

test.describe("New session chooser", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
    await openSidebar(page);
    await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  });

  // Journey: verify the mobile chooser is centered with tappable rows and a
  // Browse entry, then focus the search input and simulate a keyboard inset to
  // verify the chooser stays bounded above the keyboard.
  test("new-session chooser is centered, usable, and respects the keyboard inset", async ({
    page,
  }) => {
    const view = page.getByTestId("session-chooser");
    await expect(view).toBeVisible();
    const searchInput = view.getByLabel("Filter projects");
    await expect(searchInput).toBeVisible();

    // The composition is within the viewport bounds.
    const viewBox = await view.boundingBox();
    expect(viewBox).not.toBeNull();
    const shellBox = await page.locator(".shell").boundingBox();
    expect(shellBox).not.toBeNull();
    expect(viewBox!.y).toBeGreaterThanOrEqual(shellBox!.y - 0.5);
    expect(viewBox!.y + viewBox!.height).toBeLessThanOrEqual(
      shellBox!.y + shellBox!.height + 0.5,
    );

    // Project rows are tappable (44px touch targets).
    const projectRow = view.getByTestId("chooser-project-pantoken");
    await expect(projectRow).toBeVisible();
    const rowBox = await projectRow.boundingBox();
    expect(rowBox!.height).toBeGreaterThanOrEqual(44);

    // The Browse entry is also reachable.
    await expect(view.getByTestId("chooser-browse")).toBeVisible();

    // --- keyboard inset keeps the chooser bounded above the keyboard ---
    await searchInput.focus();

    await page.evaluate(() =>
      document.documentElement.style.setProperty("--keyboard-inset", "260px"),
    );

    const shell = page.locator(".shell");
    await expect
      .poll(() => shell.evaluate((el) => el.clientHeight))
      .toBeLessThan(600);
    // Wait for the view to settle within the shell bounds — the layout lags
    // the shell's clientHeight by a frame after the CSS-variable change.
    await expect
      .poll(async () => {
        const shellBox = await shell.boundingBox();
        const viewBox = await view.boundingBox();
        if (!shellBox || !viewBox) return false;
        return (
          viewBox.y >= shellBox.y - 0.5 &&
          viewBox.y + viewBox.height <= shellBox.y + shellBox.height + 0.5
        );
      })
      .toBe(true);
  });
});
