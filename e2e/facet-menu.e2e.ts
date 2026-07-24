import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Issue #73: the facet menu must not send spurious requests to the daemon.
// Selecting the already-active facet (Enter / click / number-key) is a no-op —
// no setFacet wire message, so no "Facet switched to X" notice and no error.
// The mock driver always succeeds on SetFacet (it never emits the "already
// active" error), so the observable signal is the *absence* of the notice: the
// notice is the side effect of a real request, so its absence proves no request
// was sent. Switching to a *different* facet still sends the request (regression
// guard), and the draft (new-session) path writes to the draft (no wire message).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("Enter on the active facet sends no request", async ({ page }) => {
  // Default facet is Execute. Open the menu (sel starts on Execute) and press
  // Enter on it — no setFacet request, so no new notice appears.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  // Execute is index 0 — the default highlight.
  await expect(panel.getByRole("option", { name: "Execute" })).toHaveClass(/hl/);
  const before = await page.locator(".row.notice .ntext").count();
  await panel.press("Enter");
  await expect(panel).not.toBeVisible();
  // No new "Facet switched to execute" notice — the request was suppressed.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);
  await expect(badge).toHaveText("Execute");
});

test("clicking the active facet row sends no request", async ({ page }) => {
  // Default facet is Execute. Open the menu and click the Execute row — no
  // setFacet request, so no new notice appears.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  const before = await page.locator(".row.notice .ntext").count();
  await page.getByRole("option", { name: "Execute" }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);
  await expect(badge).toHaveText("Execute");
});

test("number-key on the active facet sends no request", async ({ page }) => {
  // Default facet is Execute (index 0 → number key "1"). Open the menu and
  // press "1" — no setFacet request, so no new notice appears.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  const before = await page.locator(".row.notice .ntext").count();
  await page.keyboard.press("1");
  await expect(panel).not.toBeVisible();
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);
  await expect(badge).toHaveText("Execute");
});

test("selecting a different facet still switches", async ({ page }) => {
  // Regression guard: switching to a *different* facet must still send the
  // setFacet request and produce a new notice.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");
  await badge.click();
  const before = await page.locator(".row.notice .ntext").count();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toHaveText("Plan");
  // The mock emits a "Facet switched to plan" notice on a real setFacet.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before + 1);
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    /plan/i,
  );
});

test("facet selection while drafting writes to the draft", async ({ page }) => {
  // AC.8 — while a new-session draft is open, selecting a facet writes to the
  // draft (no daemon request, no error). The handoff toggle is now visible on
  // the Plan row while drafting, but it only edits the draft field (no daemon
  // request), so only the facet pick is exercised here.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByTestId("sidebar-new-session")
    .getByText("New session")
    .click();
  await expect(page.getByTestId("new-session")).toBeVisible();
  const draftBadge = page.getByTestId("facet-badge");
  await expect(draftBadge).toHaveText("Execute");

  const before = await page.locator(".row.notice .ntext").count();
  // Open the picker and select Plan — writes to the draft, no wire message.
  await draftBadge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(draftBadge).toHaveText("Plan");
  // No new notice (draft path sends no wire message) and no error.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(before);
  await expect(page.locator(".row.error")).toHaveCount(0);

  // Navigate back to the old session — its facet is unchanged ("Execute"),
  // proving the draft pick didn't leak into the live session.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .locator(".row", { hasText: "Explore the fold reducer" })
    .click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");
});

test("handoff flush is draft-guarded: committing a facet pick while drafting sends no handoff request", async ({
  page,
}) => {
  // Set up: switch the live session to Plan and enable adventurous handoff, so
  // store.session.adventurousHandoff is true. Then open a draft and commit a
  // facet pick — the handoff flush must NOT fire (it's draft-guarded), even
  // though pendingHandoff (snapshotted from the live session's true value)
  // differs from the draft's (nonexistent) handoff state.
  await page.getByTestId("facet-badge").click();
  await page.getByRole("option", { name: "Plan" }).click();
  await page.getByTestId("facet-badge").click();
  const toggle = page.getByTestId("adventurous-handoff");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // Commit the handoff toggle (Plan is already active → only the flush fires).
  await page.getByRole("listbox", { name: "Facet" }).press("Enter");
  await expect(page.locator(".row.notice .ntext").last()).toContainText(
    "Adventurous handoff enabled",
  );

  // Now open a new-session draft. The live session's handoff is on; the draft
  // has its own handoff state (defaults to off). The toggle is visible on the
  // Plan row while drafting but only edits the draft field — no daemon request
  // fires. The draft view has its own (empty) transcript, so we assert no
  // notices appear at all.
  await openSidebar(page);
  await page
    .getByTestId("sidebar")
    .getByTestId("sidebar-new-session")
    .getByText("New session")
    .click();
  await expect(page.getByTestId("new-session")).toBeVisible();
  const draftBadge = page.getByTestId("facet-badge");
  await expect(draftBadge).toHaveText("Execute");
  // Draft transcript starts empty — no notices.
  await expect(page.locator(".row.notice .ntext")).toHaveCount(0);

  // Open the facet menu and commit a facet pick (Plan) via Enter. The handoff
  // flush must NOT fire — no notice appears. setFacet also writes to the draft
  // (no wire message), so no notice from that either. The toggle appears on
  // the Plan row but is draft-aware (edits the draft, no daemon call).
  await draftBadge.click();
  const panel = page.getByRole("listbox", { name: "Facet" });
  await expect(panel).toBeVisible();
  // Move highlight to Plan and commit.
  await panel.press("ArrowDown");
  await panel.press("Enter");
  await expect(draftBadge).toHaveText("Plan");
  // No notice: setFacet wrote to the draft (no wire), and the handoff flush
  // was draft-guarded (suppressed).
  await expect(page.locator(".row.notice .ntext")).toHaveCount(0);
});
