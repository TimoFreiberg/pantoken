import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// When opening a session that the TUI holds (a 409 lease conflict), the operator
// gets a sticky toast with a "Retry" action. Tapping Retry re-sends the
// openSession; the mock's one-shot failure clears on the second attempt, so the
// session opens. Non-lease session-switch errors keep the 8s auto-dismiss toast
// (no Retry button — they aren't blindly retryable).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a lease conflict surfaces a sticky Retry toast; retrying opens the session", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Arm the one-shot 409 failure for the NEXT openSession (switching to a
  // different session triggers it).
  await drive(page, "failsession");

  // Switch to a different session — the first attempt throws the 409.
  await sidebar.getByText("Explore the fold reducer").click();

  // The toast appears with the lease-conflict message.
  const toast = page
    .getByTestId("chat-notice")
    .getByTestId("toast")
    .filter({ hasText: "another TUI is attached" });
  await expect(toast).toBeVisible();

  // The Retry action button is present (sticky — no auto-dismiss).
  await expect(
    toast.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();

  // The toast is sticky: it persists past the 8s auto-dismiss window (the operator
  // may be detaching in the TUI). Use a generous poll + a short wait to prove it.
  await page.waitForTimeout(2000);
  await expect(toast).toBeVisible();

  // Click Retry → the second openSession succeeds (the one-shot flag cleared).
  await toast.getByRole("button", { name: "Retry", exact: true }).click();

  // The session opens — its greeting text appears, proving the retry landed.
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();

  // The toast dismissed on the Retry click (the action runs dismissToast).
  await expect(toast).toHaveCount(0);
});
