import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The mock tree fixture (server/src/fixtures.ts mockTree): a linear root chain that forks
// at the plan step into the active "separate module" branch (leaf e-a3) and an abandoned
// branch captured as a summary. e-t1 is a bash/tool node (hidden in the default view),
// e-u2 is labelled "router".
const PLAN = "Routes live in server/src/index.ts";
const REDIRECT = "actually, put it in a separate health-router module";
const ANSWER = "Good call — extracting a healthRouter and mounting it.";
const SUMMARY = "explored inlining /health in index.ts";
const TOOLCMD = "rg -n";
const PROMPT = "Add a /health route to the server and a smoke test for it.";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function openTree(page: import("@playwright/test").Page) {
  await page.getByTestId("tree-toggle").click();
  await expect(page.getByTestId("tree-panel")).toBeVisible();
}

test("the header button opens the tree showing the active path, the fork and a branch summary", async ({
  page,
}) => {
  await openTree(page);
  // Default (skeleton) view: prompts + answers + the abandoned-branch summary…
  await expect(page.getByTestId("tree-list")).toContainText(REDIRECT);
  await expect(page.getByTestId("tree-list")).toContainText(ANSWER);
  await expect(page.getByTestId("tree-list")).toContainText(SUMMARY);
  // …the current leaf is flagged…
  await expect(page.getByText("current", { exact: true })).toBeVisible();
  // …and the tool node is hidden until you ask for it.
  await expect(page.getByTestId("tree-list")).not.toContainText(TOOLCMD);
});

test("filters reveal tools and narrow to prompts", async ({ page }) => {
  await openTree(page);
  // "All" reveals the hidden bash/tool node.
  await page.getByTestId("tree-filter-all").click();
  await expect(page.getByTestId("tree-list")).toContainText(TOOLCMD);
  // "Prompts" (user-only) shows just the operator's turns.
  await page.getByTestId("tree-filter-user-only").click();
  await expect(page.getByTestId("tree-list")).toContainText(REDIRECT);
  await expect(page.getByTestId("tree-list")).not.toContainText(ANSWER);
  await expect(page.getByTestId("tree-list")).not.toContainText(PLAN);
});

test("search filters the rows by text", async ({ page }) => {
  await openTree(page);
  await page.getByTestId("tree-search").fill("module");
  await expect(page.getByTestId("tree-list")).toContainText(REDIRECT);
  // The early plan step doesn't mention "module", so it drops out.
  await expect(page.getByTestId("tree-list")).not.toContainText(
    "I'll look at how routes",
  );
});

test("branching from a tree node rewinds the transcript and prefills the composer", async ({
  page,
}) => {
  await openTree(page);
  // Select the redirect prompt, then commit the branch from its row action.
  await page.getByTestId("tree-row").filter({ hasText: REDIRECT }).click();
  await page.getByTestId("tree-branch").click();
  // The modal closes, the user prompt comes back to re-edit, and the old turn is gone.
  await expect(page.getByTestId("tree-panel")).toHaveCount(0);
  await expect(page.getByPlaceholder("Message pilot…")).toHaveValue(REDIRECT);
  await expect(page.getByText(PLAN)).toHaveCount(0);
});

test("typing /tree opens the view instead of sending it", async ({ page }) => {
  await page.getByPlaceholder("Message pilot…").fill("/tree");
  await page.getByPlaceholder("Message pilot…").press("Enter");
  await expect(page.getByTestId("tree-panel")).toBeVisible();
  // It was intercepted, not sent as a prompt.
  await expect(page.getByPlaceholder("Message pilot…")).toHaveValue("");
  await expect(page.getByTestId("tree-list")).toContainText(PROMPT);
});

test("Escape closes the tree", async ({ page }) => {
  await openTree(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tree-panel")).toHaveCount(0);
});

test("⌘⇧T toggles the tree view", async ({ page }) => {
  await page.getByPlaceholder("Message pilot…").click();
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByTestId("tree-panel")).toBeVisible();
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByTestId("tree-panel")).toHaveCount(0);
});
