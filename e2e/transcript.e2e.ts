import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: an extension compatibility issue folds into a warning notice, while
// the composer footer keeps showing the model and healthy connection chrome
// stays quiet.
test("compat warnings fold into a notice; the composer footer shows the model", async ({
  page,
}) => {
  await drive(page, "compat");
  const notice = page.locator(".notice.warning");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Extension capability "custom"');
  await expect(notice).toContainText("terminal-only");

  // The model label lives in the composer status row (moved out of the header).
  await expect(
    page.getByTestId("composer-status-right").getByTestId("model-badge"),
  ).toContainText("Claude Opus 4.8");
  await expect(page.locator(".hdr .conn")).toHaveCount(0);
});

// Journey: the greeting conversation renders with a collapsed working section,
// and expanding reveals the narration + both tool cards.
test("renders the greeting conversation: user, collapsed work, final answer", async ({
  page,
}) => {
  // User prompt + the turn-final answer are always visible…
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
  await expect(page.getByText("Routes live in")).toBeVisible();
  // …but the working section (narration + tool) is collapsed behind "Worked for Ns".
  await expect(page.getByTestId("work-toggle")).toContainText("Worked for");
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toHaveCount(0);
  await expect(page.getByText("Run shell command")).toHaveCount(0);

  // Expanding reveals the narration and the tool cards (greeting has 2 tools).
  await expandWork(page);
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toBeVisible();
  const tool = page.getByTestId("work-body").locator(":scope > .tool");
  await expect(tool).toHaveCount(2);
  await expect(tool.first().locator(":scope > .head .name")).toHaveText(
    "Run shell command",
  );
});

// Journey: a tool card expands to show its output.
test("tool card expands to show output", async ({ page }) => {
  await expandWork(page);
  const head = page.getByTestId("work-body").locator(":scope > .tool > .head").first();
  await expect(head).toBeVisible();
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("server/src/index.ts:14")).toBeVisible();
});

// Journey: a tool card expands to show the full arguments.
test("tool card expands to show the full arguments", async ({ page }) => {
  await expandWork(page);
  const head = page.getByTestId("work-body").locator(":scope > .tool > .head").first();
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  // The args block labels each input key and shows its full value in a <pre> —
  // the collapsed header only renders a truncated single-line preview.
  const args = page.locator(".tool .args");
  await expect(args.locator(".arg-key", { hasText: "command" })).toBeVisible();
  await expect(args.locator(".arg-val")).toContainText(
    'rg -n "app.get\\(" server/src',
  );
});

// Journey: turn virtualization must not change scroll height while scrolling
// (regression guard for the content-visibility scroll-jump).
test("turn virtualization does not change scroll height while scrolling", async ({ page }) => {
  const scroller = page.locator(".scroller");

  // Build a transcript taller than the viewport with a few markdown turns.
  for (let i = 0; i < 6; i++) {
    await drive(page, "markdown");
    await expect(
      page.getByText("Show me a markdown formatting sample."),
    ).toHaveCount(i + 1);
    const overflow = await scroller.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    if (overflow > 400) break;
  }

  // Let streaming settle: wait until scrollHeight stops changing between reads.
  let prev = -1;
  await expect
    .poll(
      async () => {
        const h = await scroller.evaluate((el) => el.scrollHeight);
        const stable = h === prev;
        prev = h;
        return stable;
      },
      { intervals: [150, 150, 200, 300, 500], timeout: 6000 },
    )
    .toBe(true);

  // Guard the intended implementation boundary: whole turns, not individual rows.
  const cv = await scroller
    .locator(".transcript-turn")
    .first()
    .evaluate((el) => getComputedStyle(el).contentVisibility);
  expect(cv).toBe("auto");

  // Behavioral invariant: retained intrinsic sizing keeps scrollHeight constant as the
  // browser realizes turns, so content above the viewport cannot move the reader.
  const hBottom = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollHeight;
  });
  const hTop = await scroller.evaluate((el) => {
    el.scrollTop = 0;
    return el.scrollHeight;
  });
  expect(hTop).toBe(hBottom);
});

// Journey: long user prompts render clamped with an expand/collapse toggle;
// short prompts have no toggle.
test("long prompts clamp with an expand toggle; short prompts have none", async ({
  page,
}) => {
  // 14 lines — over the ~10-line clamp threshold. Sent through the composer so
  // the optimistic row AND the mock's echoed userMessage both exercise the clamp.
  const longPrompt = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const box = page.locator(".composer-wrap textarea");
  await box.fill(longPrompt);
  await box.press("Enter");

  const bubble = page.locator(".row.user .btext", { hasText: "line 14" });
  await expect(bubble).toHaveClass(/clamped/);

  // Expand: the clamp lifts and the toggle flips to collapse.
  const toggle = page.getByTestId("prompt-expand");
  await expect(toggle).toHaveText(/Show full prompt/);
  await toggle.click();
  await expect(bubble).not.toHaveClass(/clamped/);
  await expect(toggle).toHaveText(/Show less/);

  // Collapse back to the preview.
  await toggle.click();
  await expect(bubble).toHaveClass(/clamped/);

  // A short prompt has no expand toggle.
  await box.fill("just a short question");
  await box.press("Enter");
  await expect(
    page.locator(".row.user .bubble", { hasText: "just a short question" }),
  ).toBeVisible();
  // The short prompt's row has no expand toggle (the long prompt's toggle above
  // belongs to its own row — scope to this row's bubble).
  await expect(
    page
      .locator(".row.user", { hasText: "just a short question" })
      .getByTestId("prompt-expand"),
  ).toHaveCount(0);
});
