import { expect, test } from "@playwright/test";
import { gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

const PROMPT = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  // Settle proxy: the prompt's "Branch from this prompt" handle backfills at the SAME
  // turn boundary as the answer's entry id, so waiting on it guarantees we're past the
  // running window (branching is a no-op mid-turn). We can't wait on "Branch from here"
  // here anymore — the greeting's lone answer IS the active-path tip, so its button is
  // intentionally suppressed (branching from the tip would be a no-op).
  await expect(
    page.getByRole("button", { name: "Branch from this prompt" }),
  ).toBeVisible();
});

test("the leaf answer hides 'Branch from here'; the prompt still offers re-edit", async ({
  page,
}) => {
  // The greeting prompt is re-editable…
  await expect(
    page.getByRole("button", { name: "Branch from this prompt" }),
  ).toBeVisible();
  // …but its answer is the current tip, so "continue on a new path from here" is a
  // no-op and the button is gone.
  await expect(
    page.getByRole("button", { name: "Branch from here" }),
  ).toHaveCount(0);
});

test("an earlier turn's answer offers 'Branch from here' once it's no longer the tip", async ({
  page,
}) => {
  // Send a second prompt so the greeting's answer stops being the active-path tip.
  const box = page.getByPlaceholder("Message pilot…");
  await box.fill("now make it return JSON");
  await box.press("Enter");
  await waitForSettledWorkBlocks(page, 2);

  // Exactly one "Branch from here": on the greeting (now non-leaf) turn. The new turn's
  // answer is the tip, so it stays suppressed.
  const branch = page.getByRole("button", { name: "Branch from here" });
  await expect(branch).toHaveCount(1);

  // Position check defeats an inverted gate (which would also yield count 1, but on the
  // leaf): the surviving button must sit ABOVE the second prompt, i.e. on the older turn.
  const branchBox = await branch.boundingBox();
  const secondPromptBox = await page
    .getByText("now make it return JSON")
    .boundingBox();
  expect(branchBox).not.toBeNull();
  expect(secondPromptBox).not.toBeNull();
  expect(branchBox!.y).toBeLessThan(secondPromptBox!.y);
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
