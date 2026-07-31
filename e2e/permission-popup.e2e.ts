import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Exercises the new `permission` HostUiRequest kind: the card surfaces the tool
// name + a JSON preview of the tool's input, and renders only the pruned approval
// options (keep_targets=[session] → Deny + Allow once + Allow for session).
// The fixture (permissionDialog in fixtures.ts) uses the shared
// pruneApprovalOptions helper so the pruning logic can't drift from the forward
// mapping.

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
});

test("permission card: clicking Allow for session resolves the card", async ({
  page,
}) => {
  await drive(page, "permission");
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("radio", { name: "Allow for session", exact: true })
    .click();
  // The mock acks a value response with "Received: <value>".
  await expect(page.getByText("Received: Allow for session")).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("permission card: Escape cancels (deny-safe)", async ({ page }) => {
  await drive(page, "permission");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

test("permission card is an arrow-navigable radiogroup", async ({ page }) => {
  await drive(page, "permission");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radiogroup")).toBeVisible();
  const options = dialog.getByRole("radio");
  await expect(options).toHaveCount(3);

  // ArrowDown moves focus + marks the option selected (roving tabindex).
  await options.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");

  // Enter submits the focused radio.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Received: Allow once")).toBeVisible();
});
