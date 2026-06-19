import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

const PROMPT = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // Wait past the running window — the assistant branch button appears only once the
  // turn settles (see branch.e2e.ts). Branching is a no-op mid-turn.
  await expect(
    page.getByRole("button", { name: "Branch from here" }),
  ).toBeVisible();
});

// On a phone there's no hover, so the branch affordance must be reachable without one
// (the desktop reveal-on-hover would otherwise leave it tappable-but-invisible).
test("branch button is reachable on touch and rewinds the transcript", async ({
  page,
}) => {
  const branch = page.getByRole("button", { name: "Branch from this prompt" });
  await expect(branch).toBeVisible();
  await branch.tap();
  await expect(page.getByPlaceholder("Message pilot…")).toHaveValue(PROMPT);
  await expect(page.getByText("Routes live in")).toHaveCount(0);
});
