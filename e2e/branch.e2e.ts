import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

const PROMPT = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // The assistant "Branch from here" button only renders once the turn has SETTLED
  // (and its entry id backfilled), so waiting on it guarantees we're past the running
  // window before we try to branch — branching is a no-op mid-turn.
  await expect(
    page.getByRole("button", { name: "Branch from here" }),
  ).toBeVisible();
});

test("the greeting's prompt and turn-final answer each offer a branch button", async ({
  page,
}) => {
  // Both branch handles come from the fixture (user e-u1, assistant e-a1).
  await expect(
    page.getByRole("button", { name: "Branch from this prompt" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Branch from here" }),
  ).toBeVisible();
});

test("branching from a user prompt rewinds the transcript and prefills the composer", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Branch from this prompt" }).click();

  // The re-edit gesture: the prompt text comes back in the composer…
  await expect(page.getByPlaceholder("Message pilot…")).toHaveValue(PROMPT);
  // …and the branch rewound to before it, so the old turn's answer is gone.
  await expect(page.getByText("Routes live in")).toHaveCount(0);
  await expect(page.getByText("No messages yet")).toBeVisible();
});

test("Cmd/Ctrl+Shift+↑ branches from the last prompt", async ({ page }) => {
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect(page.getByPlaceholder("Message pilot…")).toHaveValue(PROMPT);
  await expect(page.getByText("Routes live in")).toHaveCount(0);
});
