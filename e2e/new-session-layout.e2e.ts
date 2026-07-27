import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the chooser centres its composition without the old hero", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const view = page.getByTestId("session-chooser");
  await expect(
    view.getByRole("heading", { name: "What would you like to work on?" }),
  ).toBeVisible();
  // The chooser has a search input, not a composer.
  await expect(view.getByLabel("Filter projects")).toBeVisible();
  await expect(view.getByRole("listbox", { name: "Choose a project" })).toHaveCount(1);
  // No composer is mounted while the chooser is open.
  await expect(page.getByRole("group", { name: "Message composer" })).toHaveCount(
    0,
  );

  // The composition is vertically centred-ish (top-aligned with generous padding,
  // not pinned to the bottom like a live-session composer).
  const viewBox = await view.boundingBox();
  const headingBox = await view
    .getByRole("heading", { name: "What would you like to work on?" })
    .boundingBox();
  expect(viewBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  const headingCentre = headingBox!.y + headingBox!.height / 2;
  const relativeCentre = (headingCentre - viewBox!.y) / viewBox!.height;
  expect(relativeCentre).toBeGreaterThan(0.05);
  expect(relativeCentre).toBeLessThan(0.4);
});

test("the chooser shows project rows and a Browse entry", async ({ page }) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const view = page.getByTestId("session-chooser");
  // The mock fixtures have projects: pantoken, retry-lib, scratch.
  await expect(view.getByTestId("chooser-project-pantoken")).toBeVisible();
  await expect(view.getByTestId("chooser-project-retry-lib")).toBeVisible();
  await expect(view.getByTestId("chooser-browse")).toBeVisible();
});

test("non-drafting state has no scope row and composer surface keeps rounded corners", async ({
  page,
}) => {
  await expect(page.getByTestId("scope-row")).toHaveCount(0);

  const surface = page.getByTestId("composer-surface");
  await expect(surface).not.toHaveCSS("border-top-left-radius", "0px");
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

test("creating a session moves from chooser to transcript layout", async ({
  page,
}) => {
  const oldPrompt = page.getByText("Add a /health route to the server");
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  // Select the pantoken project (pre-selected) — Enter creates a session.
  await page.getByLabel("Filter projects").press("Enter");

  // The chooser is gone and the live-session composer is mounted.
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("start from the centre");
  await composer.press("Enter");

  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
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

test("chooser Escape closes back to the previous view", async ({ page }) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
});
