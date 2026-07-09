import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the overflow menu renames a session, updating the row in place", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();

  // Open the overflow menu and pick Rename.
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Rename", exact: true }).click();

  // The inline editor appears, prefilled with the current name (the row is gone —
  // the form replaces it in place).
  const input = sidebar.locator(".rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Explore the fold reducer");

  // Type a new name and save.
  await input.fill("Fold reducer deep-dive");
  await sidebar.getByRole("button", { name: "Save", exact: true }).click();

  // The row reflects the new name (optimistic + server reconcile); the old one is gone.
  await expect(sidebar.getByText("Fold reducer deep-dive")).toBeVisible();
  await expect(sidebar.getByText("Explore the fold reducer")).toHaveCount(0);
});

test("Escape cancels a rename without changing the name", async ({ page }) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket bridge" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Rename", exact: true }).click();

  const input = sidebar.locator(".rename-input");
  await input.fill("Discarded name");
  await input.press("Escape");

  // The editor closes and the original name is intact.
  await expect(sidebar.locator(".rename-input")).toHaveCount(0);
  await expect(sidebar.getByText("Wire up the WebSocket bridge")).toBeVisible();
  await expect(sidebar.getByText("Discarded name")).toHaveCount(0);
});

test("renaming a non-focused session doesn't switch the active session", async ({
  page,
}) => {
  // docs/TODO.md: "renaming a cold session hijacks activeSessionId (and
  // spawns a daemon)". The mock has no warm/cold distinction (that half is
  // covered by Rust driver/live-path tests against the real daemon client),
  // but the client-observable half — does the rename ever move focus — is
  // fully exercisable here: "Wire up the WebSocket bridge" (demo-session) is
  // the default-focused greeting session; "Explore the fold reducer" is a
  // different, non-focused row. Renaming the latter via the overflow menu
  // (never clicking into the row itself) must not touch the former's focus.
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  const activeRow = sidebar.locator("button.row.active");
  await expect(activeRow).toContainText("Wire up the WebSocket bridge");

  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByRole("menuitem", { name: "Rename", exact: true }).click();

  const input = sidebar.locator(".rename-input");
  await input.fill("Fold reducer, take two");
  await sidebar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sidebar.getByText("Fold reducer, take two")).toBeVisible();

  // The renamed row did not take focus...
  const renamedRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Fold reducer, take two" })
    .locator("button.row");
  await expect(renamedRow).not.toHaveClass(/\bactive\b/);
  // ...and the greeting session is still the (only) active one.
  await expect(activeRow).toContainText("Wire up the WebSocket bridge");
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);
});
