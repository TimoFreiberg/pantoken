import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => gotoFresh(page));

const picker = (page: Page) => page.getByTestId("dir-picker");
const pathInput = (page: Page) => page.getByLabel("Project directory path");

/** Open the chooser, then the DirPicker via the Browse… button. */
async function openPicker(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  await page.getByTestId("chooser-browse").click();
  await expect(picker(page)).toBeVisible();
  // Move the mouse off the picker's result list so no mouseenter fires on a
  // directory row (the click on Browse… lands mid-screen, and the DirPicker's
  // centered dialog can open with its results under the cursor).
  await page.mouse.move(0, 0);
  await expect(pathInput(page)).toBeFocused();
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
}

// Journey: the desktop DirPicker presents a centered server-filesystem command
// palette, and Escape closes it back to the chooser.
test("desktop presents a centered server-filesystem command palette; Escape returns to the chooser", async ({
  page,
}) => {
  await openPicker(page);
  await expect(
    picker(page).getByText("Choose project directory"),
  ).toBeVisible();
  await expect(page.getByTestId("dir-picker-server")).not.toHaveText("");
  await expect(
    picker(page).locator(".recent-chip, .bc, .home-btn, .foot"),
  ).toHaveCount(0);
  const box = await picker(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(560);
  expect(box!.width).toBeLessThanOrEqual(680);
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(
    2,
  );

  // Escape closes the picker and returns to the chooser.
  await pathInput(page).press("Escape");
  await expect(picker(page)).toBeHidden();
  // The chooser is still open after closing the DirPicker.
  await expect(page.getByTestId("session-chooser")).toBeVisible();
});

// Journey: Tab never commits an already-exact directory, but completes a
// partial path; choosing an exact current path closes both picker and chooser.
test("Tab completes directories but never commits an already exact path", async ({
  page,
}) => {
  await openPicker(page);
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
  const initial = await pathInput(page).inputValue();
  await pathInput(page).press("Tab");
  await expect(picker(page)).toBeVisible();
  await expect(pathInput(page)).toHaveValue(initial);

  await pathInput(page).fill("/Users/timo/src/sr");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "scratch",
  );
  await pathInput(page).press("Tab");
  await expect(pathInput(page)).toHaveValue("/Users/timo/src/scratch/");
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
  await page.getByTestId("use-current-directory").click();
  // Picking a dir calls createSession — both picker and chooser close.
  await expect(picker(page)).toBeHidden();
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
});

// Journey: Right Arrow completes only with a collapsed caret at the end; then
// arrow and Emacs-style keys move the active directory before opening it.
test("arrow keys and Right-Arrow completion navigate the directory list", async ({
  page,
}) => {
  await openPicker(page);
  const input = pathInput(page);
  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(5, 5),
  );
  await input.press("ArrowRight");
  await expect(input).toHaveValue("/Users/timo/src/pi");
  await input.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(node.value.length, node.value.length),
  );
  await input.press("ArrowRight");
  await expect(input).toHaveValue("/Users/timo/src/pi/");

  // ArrowDown moves the active directory to the second match before Enter opens it.
  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("/Users/timo/src/pi-gui/");

  // Emacs-style Ctrl+n also moves down before opening.
  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.press("Control+n");
  await input.press("Enter");
  await expect(input).toHaveValue("/Users/timo/src/pi-gui/");

  // Ctrl+p moves back up to the first match.
  await input.fill("/Users/timo/src/pi");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "pi",
  );
  await input.press("ArrowDown");
  await input.press("Control+p");
  await input.press("Enter");
  await expect(input).toHaveValue("/Users/timo/src/pi/");
});

// Journey: Backspace and Option+Backspace remain ordinary text editing, then a
// home-relative path resolves on the server with hidden directories visible.
test("Backspace stays ordinary editing; home-relative paths resolve", async ({
  page,
}) => {
  await openPicker(page);
  const input = pathInput(page);
  await input.fill("/Users/timo/src/pantoken");
  await input.press("Backspace");
  await expect(input).toHaveValue("/Users/timo/src/pantoke");
  // Word-delete is platform-specific: Option+Backspace on macOS, Ctrl+Backspace on
  // Linux/Windows. CI runs Chromium on Linux (see hotkeys.e2e.ts), so pick the
  // modifier that actually deletes a word on the host.
  const wordDelete =
    process.platform === "darwin" ? "Alt+Backspace" : "Control+Backspace";
  await input.press(wordDelete);
  await expect(input).not.toHaveValue("/Users/timo/src/pantoke");
  await expect(picker(page)).toBeVisible();

  // Home-relative paths resolve on the server; hidden directories remain visible.
  await input.fill("~/.c");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    ".config",
  );
  await input.press("Tab");
  await expect(input).toHaveValue("~/.config/");
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
});

// Journey: unreadable paths show a bounded error and rapid typing keeps the
// latest result; prefix matches lead fuzzy matches and directories navigate
// before selection.
test("unreadable paths error; fuzzy prefix matches navigate and select", async ({
  page,
}) => {
  await openPicker(page);
  await pathInput(page).fill("/not/a/readable/directory/");
  await expect(picker(page).getByRole("alert")).toContainText("can’t be read");

  await pathInput(page).fill("/Users/timo/src/p");
  await pathInput(page).fill("/Users/timo/src/scr");
  await expect(picker(page).locator(".directory .name").first()).toHaveText(
    "scratch",
  );
  await expect(
    picker(page).locator(".directory .name", { hasText: "pantoken" }),
  ).toHaveCount(0);

  // Prefix matches lead fuzzy matches.
  await pathInput(page).fill("/Users/timo/src/pi");
  const names = picker(page).locator(".directory .name");
  await expect(names.first()).toHaveText("pi");
  await expect(names.nth(1)).toHaveText("pi-gui");

  // Enter navigates into the active directory (path gains a trailing slash).
  await pathInput(page).press("Enter");
  await expect(pathInput(page)).toHaveValue("/Users/timo/src/pi/");
  await expect(page.getByTestId("use-current-directory")).toBeVisible();
  await expect(picker(page)).toBeVisible();

  // Pressing Enter again on an exact path selects it — createSession fires and
  // both the picker and chooser disappear.
  await pathInput(page).press("Enter");
  await expect(picker(page)).toBeHidden();
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
});

// Journey: desktop focus remains trapped between the visible modal controls.
test("desktop focus remains trapped between the visible modal controls", async ({
  page,
}) => {
  await openPicker(page);
  await pathInput(page).fill("/Users/timo/src/");
  const close = picker(page).locator(".close");
  const lastResult = picker(page).locator(".result").last();
  await expect(lastResult).toBeVisible();
  await close.focus();
  await close.press("Shift+Tab");
  await expect(lastResult).toBeFocused();
  await lastResult.press("Tab");
  await expect(close).toBeFocused();
});
