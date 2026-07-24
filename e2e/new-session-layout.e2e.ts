import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("deferred new sessions centre the real composer without the old hero", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const view = page.getByTestId("new-session");
  const composer = view.getByRole("group", { name: "Message composer" });
  await expect(
    view.getByRole("heading", { name: "What would you like to work on?" }),
  ).toBeVisible();
  await expect(composer).toHaveCount(1);
  await expect(view.getByText("Created when you send")).toBeVisible();
  await expect(view.getByText("Nothing is created until you send")).toHaveCount(
    0,
  );
  await expect(view.getByRole("button", { name: /Cancel/ })).toHaveCount(0);

  const viewBox = await view.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(viewBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const centre = composerBox!.y + composerBox!.height / 2;
  const relativeCentre = (centre - viewBox!.y) / viewBox!.height;
  expect(relativeCentre).toBeGreaterThan(0.32);
  expect(relativeCentre).toBeLessThan(0.55);
});

test("draft chips live in one scope row above the composer surface, not in the status row", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const scope = page.getByTestId("scope-row");
  const surface = page.getByTestId("composer-surface");
  await expect(scope).toHaveCount(1);
  await expect(scope.getByTestId("draft-project-control")).toHaveCount(1);
  await expect(scope.getByTestId("draft-worktree-control")).toHaveCount(1);
  await expect(scope.getByTestId("draft-branch-control")).toHaveCount(0);

  const scopeBox = await scope.boundingBox();
  const surfaceBox = await surface.boundingBox();
  expect(scopeBox).not.toBeNull();
  expect(surfaceBox).not.toBeNull();
  expect(scopeBox!.y + scopeBox!.height).toBeLessThanOrEqual(
    surfaceBox!.y + 0.5,
  );

  const status = page.getByTestId("composer-status-row");
  await expect(status.getByTestId("draft-project-control")).toHaveCount(0);
  await expect(status.getByTestId("draft-worktree-control")).toHaveCount(0);
  await expect(status.getByTestId("permission-badge")).toBeVisible();
});

test("scope row preserves a quiet rounded surface and slim controls", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const scope = page.getByTestId("scope-row");
  const surface = page.getByTestId("composer-surface");
  const styles = await scope.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      background: css.backgroundColor,
      pageBackground: getComputedStyle(document.body).backgroundColor,
      radius: css.borderTopLeftRadius,
      border: css.border,
      marginBottom: css.marginBottom,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.background).not.toBe(styles.pageBackground);
  expect(styles.radius).not.toBe("0px");
  expect(styles.border).toMatch(/0px|none/);
  expect(styles.marginBottom).toBe("0px");
  expect(styles.height).toBeLessThanOrEqual(34);
  await expect(scope.locator(".chip").first()).toHaveCSS("font-size", "12px");
  await expect(surface).not.toHaveCSS("border-top-left-radius", "0px");
});

test("non-drafting state has no scope row and composer surface keeps rounded corners", async ({
  page,
}) => {
  await expect(page.getByTestId("scope-row")).toHaveCount(0);

  const surface = page.getByTestId("composer-surface");
  await expect(surface).not.toHaveCSS("border-top-left-radius", "0px");
});

test("keyboard shortcuts toggle picker and worktree while drafting", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  // ⌥P opens the project menu.
  await page.keyboard.press("Alt+p");
  await expect(page.getByTestId("project-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-menu")).toBeHidden();

  // ⌥W toggles the worktree chip's aria-pressed.
  const worktree = page.getByTestId("draft-worktree-control");
  await expect(worktree).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Alt+w");
  await expect(worktree).toHaveAttribute("aria-pressed", "true");
});

test("existing sessions keep the composer at the bottom", async ({ page }) => {
  const chat = page.locator(".chat");
  const composer = page.getByRole("group", { name: "Message composer" });
  const chatBox = await chat.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(chatBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const bottomGap =
    chatBox!.y + chatBox!.height - (composerBox!.y + composerBox!.height);
  expect(Math.abs(bottomGap)).toBeLessThan(2);
  await expect(page.getByText("What would you like to work on?")).toHaveCount(
    0,
  );
});

test("first send moves directly from centred draft to transcript layout", async ({
  page,
}) => {
  const oldPrompt = page.getByText("Add a /health route to the server");
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await page
    .getByPlaceholder("Describe a task or ask a question…")
    .fill("start from the centre");
  await page
    .getByPlaceholder("Describe a task or ask a question…")
    .press("Enter");

  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(page.locator(".row.user .bubble").first()).toHaveText(
    "start from the centre",
  );
  await expect(oldPrompt).toHaveCount(0);
  const chatBox = await page.locator(".chat").boundingBox();
  const composerBox = await page
    .getByRole("group", { name: "Message composer" })
    .boundingBox();
  expect(chatBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const bottomGap =
    chatBox!.y + chatBox!.height - (composerBox!.y + composerBox!.height);
  expect(Math.abs(bottomGap)).toBeLessThan(2);
});

test("draft Escape remains available after removing the central Cancel button", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  const input = page.getByPlaceholder("Describe a task or ask a question…");
  await input.focus();
  await input.press("Escape");
  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
});
