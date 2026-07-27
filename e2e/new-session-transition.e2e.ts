import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The transition from the chooser to a new transcript must never expose the
// previously focused session. The warm-up placeholder (creatingSession) carries
// the gap until the new session's snapshot lands.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a new session created via the chooser never flashes the previously focused transcript", async ({
  page,
}) => {
  // The greeting (demo) session is focused on load — its prompt is in the transcript.
  const oldPrompt = page.getByText("Add a /health route to the server");
  await expect(oldPrompt).toBeVisible();

  // Open the chooser and create a session (prompt-less create-on-click).
  await openSidebar(page);
  await page.getByTestId("sidebar").getByTestId("sidebar-new-session").getByText("New session").click();
  await expect(page.getByTestId("session-chooser")).toBeVisible();

  // The pre-selected project (pantoken) — Enter creates a session immediately.
  await page.getByLabel("Filter projects").press("Enter");

  // The chooser is gone. The warm-up indicator may flash briefly, but the mock
  // seeds fast — the critical invariant is that the old session's content never
  // appears during the transition.
  await expect(page.getByTestId("session-chooser")).toHaveCount(0);
  // No stop button during warm-up — there's no turn to abort yet.
  await expect(page.getByTestId("stop-button")).toHaveCount(0);
  // The old session's content never appears during warm-up or after seeding.
  await expect(oldPrompt).toHaveCount(0);

  // The live-session composer mounts once the seed lands.
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("kick off the brand new session please");
  await composer.press("Enter");

  // The just-sent prompt is the FIRST (and only) transcript bubble — the old session's
  // content is gone, never showing the new prompt appended below a stale transcript.
  const firstBubble = page.locator(".row.user .bubble").first();
  await expect(firstBubble).toHaveText("kick off the brand new session please");
  await expect(oldPrompt).toHaveCount(0);

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
