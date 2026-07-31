import { expect, test, type Page } from "@playwright/test";
import {
  gotoFresh,
  openSidebar,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const composerTextarea = (page: import("@playwright/test").Page) =>
  page.getByTestId("composer-box").locator("textarea");
const sendButton = (page: import("@playwright/test").Page) =>
  page.locator("button.send");

const ta = ".composer-wrap textarea";

/** Read the textarea's box metrics in one round-trip. */
function metrics(page: import("@playwright/test").Page) {
  return page.$eval(ta, (el) => {
    const t = el as HTMLTextAreaElement;
    return {
      clientH: t.clientHeight,
      scrollH: t.scrollHeight,
      clientW: t.clientWidth,
      scrollW: t.scrollWidth,
    };
  });
}

// Model picker opens and closes via Escape
test("the model picker opens and closes", async ({ page }) => {
  const model = page.getByTestId("model-badge");

  await model.click();
  const filter = page.getByPlaceholder("Type to filter…");
  await expect(filter).toBeVisible();
  await filter.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mp .panel").first()).not.toBeVisible();
});

// New-session chooser shows a search input and project list, not a composer
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

// Empty prompts are forbidden (issue #74): send button disabled and Enter does nothing
test("empty prompts are blocked: send button disabled and Enter does nothing (issue #74)", async ({
  page,
}) => {
  // --- Empty prompts are forbidden (issue #74) ---
  // The polytoken daemon forbids empty prompts, so the frontend blocks sending
  // an empty prompt in ALL states — idle (previously a "continue" signal per
  // issue #21, now removed), mid-turn (empty steer), and on a live session.
  // An image-only prompt is still valid. Issue #74 supersedes #21.

  const textarea = composerTextarea(page);
  // After gotoFresh the greeting has settled (idle). The composer is empty.
  await expect(textarea).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();

  // Before this turn there is one settled work block (the greeting).
  // Focus and press Enter on the empty composer.
  await expect(textarea).toHaveValue("");
  await textarea.click();
  await page.keyboard.press("Enter");
  // No new turn starts: still one settled work block.
  await expect(textarea).toHaveValue("");
  await waitForSettledWorkBlocks(page, 1);
  // The composer is still empty (nothing was sent).
  await expect(textarea).toHaveValue("");
});

// Composer textarea sizing: never scrolls horizontally, grows with lines, then caps with a scrollbar
test("composer textarea sizing: no horizontal scroll, grows then caps", async ({
  page,
}) => {
  const empty = await metrics(page);

  // A long unbroken token wraps; horizontal scroll must never appear (overflow-x: hidden).
  await page.fill(
    ta,
    "https://example.com/a/really/long/unbroken/path/" + "x".repeat(200),
  );
  const m = await metrics(page);
  // Text wraps; horizontal scroll must never appear (overflow-x: hidden).
  expect(m.scrollW).toBeLessThanOrEqual(m.clientW + 1);

  // Three lines fit under the cap → grows, no vertical scrollbar yet.
  await page.fill(ta, "one\ntwo\nthree");
  const three = await metrics(page);
  expect(three.clientH).toBeGreaterThan(empty.clientH);
  expect(three.scrollH).toBeLessThanOrEqual(three.clientH + 1);

  // Far past the cap → height stops growing and a vertical scrollbar appears.
  await page.fill(
    ta,
    Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
  );
  const many = await metrics(page);
  expect(many.scrollH).toBeGreaterThan(many.clientH + 10);
  // The cap on the 850px-tall desktop viewport is ~168px (≈6.5 lines),
  // well under "eats the screen".
  expect(many.clientH).toBeLessThanOrEqual(180);
  expect(many.scrollW).toBeLessThanOrEqual(many.clientW + 1);
});
