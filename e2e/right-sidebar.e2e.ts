import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// The right context panel (RightSidebar) shows the active session's flagged
// files + todos — live session context the daemon carries on every /state
// snapshot. Driven by a snapshot carrying flags/todos → foldEvent →
// state.flags/todos → RightSidebar. Toggled by the StatusHeader button or ⌘⇧J.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the context panel renders flagged files and todos", async ({ page }) => {
  // Before driving `context`: panel is closed.
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute("data-open", "false");

  // Open the panel.
  await page.getByTestId("context-toggle").click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute("data-open", "true");

  // Drive the context fixture → a snapshot with flags + todos lands.
  await drive(page, "context");

  // Flagged files render (AC.1).
  const files = page.getByTestId("flagged-files");
  await expect(files).toBeVisible();
  await expect(files).toContainText("src/app.ts");
  await expect(files).toContainText("README.md");

  // Todos render with titles (AC.2).
  const todos = page.getByTestId("todos");
  await expect(todos).toBeVisible();
  await expect(todos).toContainText("Wire up the right sidebar");
  await expect(todos).toContainText("Add e2e tests");
});

test("the context panel toggles open and closed", async ({ page }) => {
  const toggle = page.getByTestId("context-toggle");
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute("data-open", "false");

  // Open.
  await toggle.click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute("data-open", "true");

  // Close.
  await toggle.click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute("data-open", "false");
});

test("the context panel shows empty states when no flags/todos", async ({ page }) => {
  await page.getByTestId("context-toggle").click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute("data-open", "true");

  // The default mock snapshot has no flags/todos → empty states.
  await expect(page.getByTestId("flagged-files")).toContainText("No flagged files");
  await expect(page.getByTestId("todos")).toContainText("No todos");
});
