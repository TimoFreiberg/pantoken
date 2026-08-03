import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Shared boot: reset the mock to its initial fixture, load the app, and wait for
// the greeting conversation to settle before each flow.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Journey: confirm requests are independently resolved on one boot.
test("confirm dialog: allow, layout, deny, label, and Escape journeys", async ({ page }) => {
  await drive(page, "confirm");
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Run destructive command?")).toBeVisible();
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Approved — continuing.")).toBeVisible();

  await drive(page, "confirm");
  dialog = page.getByRole("dialog");
  const allow = dialog.getByRole("button", { name: "Allow" });
  const deny = dialog.getByRole("button", { name: "Deny" });
  const allowBox = await allow.boundingBox();
  const denyBox = await deny.boundingBox();
  expect(allowBox).not.toBeNull();
  expect(denyBox).not.toBeNull();
  if (allowBox && denyBox) {
    expect(Math.abs(allowBox.width - denyBox.width)).toBeLessThanOrEqual(2);
  }
  await deny.click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Denied — skipping that step.")).toBeVisible();

  await drive(page, "confirm");
  dialog = page.getByRole("dialog", { name: "Run destructive command?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();

  // Re-drive for the labelled-modal accessibility contract.
  await drive(page, "confirm");
  dialog = page.getByRole("dialog", { name: "Run destructive command?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

// Journey: input requests are independently resolved on one boot.
test("input dialog: submit and dirty backdrop dismissal journeys", async ({ page }) => {
  await drive(page, "input");
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Commit message")).toBeVisible();
  await dialog.getByRole("textbox").fill("My commit");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Received: My commit")).toBeVisible();

  await drive(page, "input");
  dialog = page.getByRole("dialog");
  let field = dialog.getByRole("textbox");
  await expect(field).toHaveValue("Add /health route");
  await field.fill("half-typed commit");
  await page.locator('.scrim[role="presentation"]').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("half-typed commit");
  await field.fill("Add /health route");
  await page.locator('.scrim[role="presentation"]').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("dialog")).toBeHidden();

  // Re-drive for the dirty-backdrop dismissal contract.
  await drive(page, "input");
  dialog = page.getByRole("dialog");
  field = dialog.getByRole("textbox");
  await expect(field).toHaveValue("Add /health route");
  await field.fill("half-typed commit");
  await page.locator('.scrim[role="presentation"]').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("half-typed commit");
  await field.fill("Add /health route");
  await page.locator('.scrim[role="presentation"]').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("dialog")).toBeHidden();
});

// Journey: select dialog — a 3+ option select is an arrow-navigable radiogroup.
test("a 3+ option select is an arrow-navigable radiogroup", async ({
  page,
}) => {
  await drive(page, "selectmany");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radiogroup")).toBeVisible();
  const options = dialog.getByRole("radio");
  await expect(options).toHaveCount(3);

  // The first option is the roving tab stop; ArrowDown moves focus + checks the next.
  await options.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-checked", "false");

  // Wrap past the bottom back to the top, then Enter submits the focused radio.
  await page.keyboard.press("ArrowDown"); // canary
  await page.keyboard.press("ArrowDown"); // wraps to staging
  await expect(options.nth(0)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Received: staging")).toBeVisible();
});

// Journey: ambient status — status strip + a collapsed tasklist pill that expands.
test("ambient: status strip + a collapsed tasklist pill that expands", async ({
  page,
}) => {
  await drive(page, "ambient");
  await expect(page.getByText("on main · 2 files changed")).toBeVisible();

  // The tasklist starts collapsed to a pill — count shown, tasks hidden.
  // (Accessible name comes from the visible "3 tasks" text, not the title attr.)
  const pill = page.getByRole("button", { name: /3 tasks/ });
  const task = page.getByText("add a smoke test");
  await expect(pill).toBeVisible();
  await expect(task).toBeHidden();

  // Hover peeks the list open, revealing the tasks…
  await pill.hover();
  await expect(task).toBeVisible();
  await expect(page.getByText("wire up /health route")).toBeVisible();
  // the task id is INTERNAL-only — the human-facing widget lines carry just
  // the description (`  ○ add a smoke test`), never a `#<id>` badge. Assert the three
  // task lines render and none contains a `#` (the descriptions themselves have no `#`,
  // so any `#` here would be the dropped id badge).
  const taskLines = page.locator(".tasklist .task");
  await expect(taskLines).toHaveCount(3);
  for (const line of await taskLines.all())
    await expect(line).not.toContainText("#");
  // …and moving the pointer away collapses it again (peek, not pinned).
  await page.mouse.move(0, 0);
  await expect(task).toBeHidden();

  // Clicking pins it open so it survives the pointer leaving (touch/keyboard path).
  await pill.click();
  await page.mouse.move(0, 0);
  await expect(task).toBeVisible();
});

// --- Permission card flows (absorbed from permission-popup.e2e.ts) ---
// Exercises the `permission` HostUiRequest kind: the card surfaces the tool
// name + a JSON preview of the tool's input, and renders only the pruned approval
// options (keep_targets=[session] → Deny + Allow once + Allow for session).
// The fixture (permissionDialog in fixtures.ts) uses the shared
// pruneApprovalOptions helper so the pruning logic can't drift from the forward
// mapping.

// Journey: permission card — shows tool name + input preview + pruned options.
test("permission card: shows tool name + input preview + pruned options", async ({
  page,
}) => {
  await drive(page, "permission");
  const dialog = page.getByRole("dialog", { name: "Run bash?" });
  await expect(dialog).toBeVisible();

  // The tool name renders (shell_exec).
  await expect(dialog.getByText("shell_exec")).toBeVisible();

  // The tool input preview renders — the recognizable command string is
  // visible inside the scrollable <pre>.
  const input = dialog.locator(".tool-input");
  await expect(input).toBeVisible();
  await expect(input).toContainText("rm -rf /tmp/test");

  // Only 3 options render (Deny + Allow once + Allow for session), NOT
  // the full 7 — keep_targets=[session] pruned project/user grants out.
  const options = dialog.getByRole("radio");
  await expect(options).toHaveCount(3);
  for (const label of ["Deny", "Allow once", "Allow for session"]) {
    await expect(
      dialog.getByRole("radio", { name: label, exact: true }),
    ).toBeVisible();
  }
  // The pruned-out options are absent.
  for (const label of ["Allow for project", "Allow for user"]) {
    await expect(
      dialog.getByRole("radio", { name: label }),
    ).toHaveCount(0);
  }

  await drive(page, "permission");
  const sessionDialog = page.getByRole("dialog");
  await sessionDialog.getByRole("radio", { name: "Allow for session", exact: true }).click();
  await expect(page.getByText("Received: Allow for session")).toBeVisible();
  await expect(sessionDialog).toBeHidden();

  await drive(page, "permission");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();

  await drive(page, "permission");
  const keyboardDialog = page.getByRole("dialog");
  const keyboardOptions = keyboardDialog.getByRole("radio");
  await expect(keyboardDialog.getByRole("radiogroup")).toBeVisible();
  await expect(keyboardOptions).toHaveCount(3);
  await keyboardOptions.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(keyboardOptions.nth(1)).toBeFocused();
  await expect(keyboardOptions.nth(1)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(keyboardDialog).toBeHidden();
  await expect(page.getByText("Received: Allow once")).toBeVisible();
});


