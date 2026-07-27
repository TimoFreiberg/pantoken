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

test("mobile: the chooser's search input and project rows are touch-safe", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  const vw = page.viewportSize()!.width;

  // The search input is full-width and touch-safe (≥44px).
  const search = page.getByLabel("Filter projects");
  await expect(search).toBeVisible();
  const searchBox = await search.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(searchBox!.height).toBeGreaterThanOrEqual(44);
  expect(searchBox!.x).toBeGreaterThanOrEqual(0);
  expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(vw + 0.5);

  // Project rows are touch-safe (≥44px) and within the viewport.
  const projectRow = page
    .getByTestId("session-chooser")
    .locator(".result.project")
    .first();
  await expect(projectRow).toBeVisible();
  const rowBox = await projectRow.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);
  expect(rowBox!.x).toBeGreaterThanOrEqual(0);
  expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(vw + 0.5);

  // The Browse… button is also touch-safe.
  const browse = page.getByTestId("chooser-browse");
  await expect(browse).toBeVisible();
  const browseBox = await browse.boundingBox();
  expect(browseBox).not.toBeNull();
  expect(browseBox!.height).toBeGreaterThanOrEqual(44);

  // No scope-row or draft-project-control in the chooser.
  await expect(page.getByTestId("scope-row")).toHaveCount(0);
  await expect(page.getByTestId("draft-project-control")).toHaveCount(0);
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
