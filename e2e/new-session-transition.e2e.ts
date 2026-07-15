import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The transition from a deferred draft to its new transcript must never expose the
// previously focused session. The optimistic prompt and working indicator carry the
// warm-up gap until the new session's snapshot lands.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a new session's first prompt never flashes the previously focused transcript", async ({
  page,
}) => {
  // The greeting (demo) session is focused on load — its prompt is in the transcript.
  const oldPrompt = page.getByText("Add a /health route to the server");
  await expect(oldPrompt).toBeVisible();

  // Start a fresh new-session draft (deferred creation: nothing exists until we send).
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("New session…").click();
  await expect(page.getByTestId("new-session")).toBeVisible();

  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("kick off the brand new session please");
  await composer.press("Enter");

  // The just-sent prompt is the FIRST (and only) transcript bubble — the old session's
  // content is gone, never showing the new prompt appended below a stale transcript.
  const firstBubble = page.locator(".row.user .bubble").first();
  await expect(firstBubble).toHaveText("kick off the brand new session please");
  await expect(oldPrompt).toHaveCount(0);

  // We're in the in-session view (the draft composition is gone) and the warm-up / turn indicator
  // is up — the climbing timer carries liveness feedback through warm-up; no stop button yet
  // (there's no turn to abort), then the turn's own streaming takes over.
  await expect(page.getByTestId("new-session")).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toBeVisible();
  // AC.4(a): the elapsed timer is visible during warm-up (before the first turn starts).
  await expect(page.getByTestId("working-elapsed")).toBeVisible();
  // AC.6: no stop button during warm-up — there's no turn to abort yet.
  await expect(page.getByTestId("stop-button")).toHaveCount(0);

  // The new session's OWN reply streams into ITS transcript (not the demo session's), and
  // the optimistic prompt row has handed off to the authoritative one without duplicating.
  await expect(page.getByText("On it — the session's up")).toBeVisible();
  await expect(
    page.locator(".row.user .bubble", {
      hasText: "kick off the brand new session please",
    }),
  ).toHaveCount(1);
  await expect(oldPrompt).toHaveCount(0);
});
