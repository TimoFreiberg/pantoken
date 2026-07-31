import { expect, test, type Page } from "@playwright/test";
import {
  gotoFresh,
  openSidebar,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the model picker opens and closes", async ({ page }) => {
  const model = page.getByTestId("model-badge");

  await model.click();
  const filter = page.getByPlaceholder("Type to filter…");
  await expect(filter).toBeVisible();
  await filter.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mp .panel").first()).not.toBeVisible();
});

test("the chooser view shows a search input and project list, not a composer", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  // The chooser has a search input (filter projects), not a composer textarea.
  await expect(page.getByLabel("Filter projects")).toBeVisible();
  await expect(page.getByPlaceholder("Describe a task or ask a question…")).toHaveCount(0);

  // The chooser has no draft-project-control, permission-badge, facet-badge,
  // or model-badge — those live on the live session's composer, not the chooser.
  await expect(page.getByTestId("draft-project-control")).toHaveCount(0);
  await expect(page.getByTestId("scope-row")).toHaveCount(0);

  // The chooser renders project rows and a Browse… button.
  await expect(
    page.getByTestId("session-chooser").locator(".result.project").first(),
  ).toBeVisible();
  await expect(page.getByTestId("chooser-browse")).toBeVisible();
});

// --- Empty prompts are forbidden (issue #74) ---
// The polytoken daemon forbids empty prompts, so the frontend blocks sending
// an empty prompt in ALL states — idle (previously a "continue" signal per
// issue #21, now removed), mid-turn (empty steer), and on a live session.
// An image-only prompt is still valid. Issue #74 supersedes #21.

const composerTextarea = (page: import("@playwright/test").Page) =>
  page.getByTestId("composer-box").locator("textarea");
const sendButton = (page: import("@playwright/test").Page) =>
  page.locator("button.send");

test("send button is disabled when the composer is empty (issue #74)", async ({
  page,
}) => {
  // After gotoFresh the greeting has settled (idle). The composer is empty.
  await expect(composerTextarea(page)).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();
});

test("Enter on an empty idle composer does not send (issue #74)", async ({
  page,
}) => {
  const textarea = composerTextarea(page);
  await expect(textarea).toHaveValue("");
  // Before this turn there is one settled work block (the greeting).
  // Focus and press Enter on the empty composer.
  await textarea.click();
  await page.keyboard.press("Enter");
  // No new turn starts: still one settled work block.
  await expect(textarea).toHaveValue("");
  await waitForSettledWorkBlocks(page, 1);
  // The composer is still empty (nothing was sent).
  await expect(textarea).toHaveValue("");
});
