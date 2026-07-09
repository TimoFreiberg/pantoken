import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Resolution feedback (Stage 6): the daemon reports which `@`-references it resolved
// out of a sent prompt (PromptAccepted.resolved_references) or a drained queue item
// (PendingTurnInputDrained.resolved_references), and warns when a queued item is
// dropped for a reference it couldn't resolve (PendingTurnInputDiscarded.
// missing_references). The mock driver fakes this deterministically: `mock_driver.rs`'s
// `parse_at_references` scans the sent text for `@skill:`/`@subagent:`/`@model:`/known
// file tokens.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a sent prompt with recognized @-mentions shows resolved-reference chips", async ({
  page,
}) => {
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("Ask @skill:debug to review @README.md please.");
  await page.getByRole("button", { name: "Send" }).click();

  const sentRow = page.locator(".row.user", {
    hasText: "Ask @skill:debug to review @README.md please.",
  });
  await expect(sentRow).toBeVisible();

  const chips = sentRow.locator(".ref-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText("skill");
  await expect(chips.nth(0)).toContainText("debug");
  await expect(chips.nth(0)).toHaveAttribute(
    "title",
    "Resolved reference: skill debug",
  );
  await expect(chips.nth(1)).toContainText("file");
  await expect(chips.nth(1)).toContainText("README.md");
});

test("a prompt with no recognized @-mentions shows no chips", async ({
  page,
}) => {
  const composer = page.getByPlaceholder("Message pantoken…");
  await composer.fill("Just a plain message, nothing special.");
  await page.getByRole("button", { name: "Send" }).click();

  const sentRow = page.locator(".row.user", {
    hasText: "Just a plain message, nothing special.",
  });
  await expect(sentRow).toBeVisible();
  await expect(sentRow.locator(".ref-chip")).toHaveCount(0);
});

test("discarding a queued item for a missing reference shows a visible warning", async ({
  page,
}) => {
  await drive(page, "queue");
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 2");

  await drive(page, "discardqueue");

  // The queue lost its head item…
  await expect(page.getByTestId("queue-tray")).toContainText("Queued · 1");
  await expect(page.getByTestId("queue-tray")).not.toContainText(
    "Please inspect the failing test first.",
  );
  // …and it did NOT get promoted into a user turn (contrast "deliverqueue").
  await expect(
    page.locator(".row.user", {
      hasText: "Please inspect the failing test first.",
    }),
  ).toHaveCount(0);

  // A visible warning names the missing references.
  const notice = page.locator(".notice.warning");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Queued message dropped");
  await expect(notice).toContainText('skill "ghost-skill"');
  await expect(notice).toContainText('file "ghost-file.md"');
});
