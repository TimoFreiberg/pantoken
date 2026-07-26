import { expect, test, type Page } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Touch-device composer behavior (Pixel 7 project → hasTouch). On a phone a bare Enter
// must insert a newline so multi-line prompts are typeable; send is the button (or a
// hardware ⌘/Ctrl+Enter). Desktop keeps Enter-to-send, covered elsewhere.

const composer = (page: Page) => page.locator(".composer-wrap textarea");

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("mobile: a bare Enter inserts a newline instead of sending", async ({
  page,
}) => {
  const box = composer(page);
  await box.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("line two");
  // The Enter did NOT submit: the draft survives with an embedded newline and no user
  // bubble was appended for it.
  await expect(box).toHaveValue("line one\nline two");
  await expect(page.locator(".row.user", { hasText: "line one" })).toHaveCount(
    0,
  );
});

test("mobile: the send button submits the prompt", async ({ page }) => {
  const box = composer(page);
  await box.click();
  await page.keyboard.type("sent from the button");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The button still sends: composer clears and the message lands in the transcript.
  await expect(box).toHaveValue("");
  await expect(
    page.locator(".row.user", { hasText: "sent from the button" }),
  ).toBeVisible();
});

test("mobile: the session-controls summary never overflows the viewport", async ({
  page,
}) => {
  const summary = page.getByTestId("mobile-session-controls-trigger");
  await expect(summary).toBeVisible();
  const vw = page.viewportSize()!.width;
  const box = await summary.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await expect(page.getByTestId("permission-badge")).toBeHidden();
  await expect(page.getByTestId("model-badge")).toBeHidden();
});

test("mobile: new-session scope-row chips stay tappable above the composer surface", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const scope = page.getByTestId("scope-row");
  const project = page.getByTestId("draft-project-control");
  const vw = page.viewportSize()!.width;

  await expect(scope).toHaveCount(1);
  await expect(scope.getByTestId("draft-project-control")).toHaveCount(1);
  const visibleProjectBase = (await project.innerText()).trim();
  expect(visibleProjectBase).not.toBe("");
  await expect(project).toHaveAccessibleName(
    `${visibleProjectBase} — choose a project`,
  );
  for (const control of [project]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
  }

  await expect(
    page.getByTestId("mobile-session-controls-trigger"),
  ).toBeVisible();

  await project.click();
  await expect(project).toHaveAttribute("aria-expanded", "true");
  const projectMenu = page.getByTestId("project-menu");
  await expect(projectMenu).toBeVisible();
  const projectFilter = projectMenu.getByRole("textbox", {
    name: "Filter projects",
  });
  await expect(projectFilter).toBeVisible();
  for (const [name, landmark] of [
    ["project menu", projectMenu],
    ["project filter", projectFilter],
  ] as const) {
    const box = await landmark.boundingBox();
    expect(box, `${name} should render`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height + 0.5,
    );
  }
  await projectFilter.fill("pan");
  await expect(projectFilter).toHaveValue("pan");
  await page.keyboard.press("Escape");
  await expect(projectMenu).toBeHidden();
  await expect(project).toHaveAttribute("aria-expanded", "false");
});

test("mobile: send button is disabled when the composer is empty (issue #74)", async ({
  page,
}) => {
  // Empty prompts are forbidden (issue #74), so the Send button is disabled
  // when the composer is empty — even when idle. On touch there's no Enter
  // path, so the button is the only send affordance and must stay disabled.
  const box = composer(page);
  await expect(box).toHaveValue("");
  await expect(page.locator("button.send")).toBeDisabled();
});
