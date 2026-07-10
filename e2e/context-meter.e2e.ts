import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the composer footer shows the context-window meter", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await expect(meter).toBeVisible();
  // MOCK_USAGE is 47,200 / 200,000 tokens → 24%.
  await expect(meter).toHaveText(/24%/);
  // Detail is provided only by the context menu; the ring has no competing browser tooltip.
  await expect(meter).not.toHaveAttribute("title");
});

test("a context-pressure cue surfaces once the window is nearly full", async ({
  page,
}) => {
  const cue = page.getByTestId("context-cue");
  // Baseline MOCK_USAGE is 24% — well under the ≥85% threshold, so no cue.
  await expect(cue).toHaveCount(0);

  // `contextfull` pushes the focused session to 91% (danger band).
  await drive(page, "contextfull");

  await expect(cue).toBeVisible();
  await expect(cue).toContainText("Context 91% full");
  await expect(cue).toContainText("/compact");
  // Tone tracks the meter ring: 90%+ is the danger band.
  await expect(cue).toHaveClass(/danger/);
  // The ring itself moved to 91% too.
  await expect(page.getByTestId("context-meter")).toHaveText(/91%/);
});

test("the model and effort pickers live in the composer footer", async ({
  page,
}) => {
  // Both pickers moved out of the header into the composer's footer toolbar.
  const toolbar = page.locator(".composer-wrap .toolbar");
  await expect(
    toolbar.locator(".mp .badge").filter({ hasText: "Claude Opus 4.8" }),
  ).toBeVisible();
  await expect(
    toolbar.locator(".mp .badge").filter({ hasText: "medium" }),
  ).toBeVisible();
  // …and no longer live in the header.
  await expect(page.locator(".hdr .mp")).toHaveCount(0);
});

test("the attach button opens a file picker for image attachments", async ({
  page,
}) => {
  // The attach control is now the shared IconButton primitive — select by its
  // accessible name rather than the old bespoke `.attach` class.
  const attach = page
    .locator(".composer-wrap")
    .getByRole("button", { name: "Attach images" });
  await expect(attach).toBeEnabled();
  await expect(attach).toHaveAttribute("title", /Attach images/);
});

test("the context meter popup shows detail on click", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await expect(meter).toBeVisible();
  // Click the meter to pin the popup open.
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(/tokens/);
  await expect(popup).toContainText(/of window/);
  // The popup has Compact + Clear context action buttons.
  await expect(page.getByTestId("compact-btn")).toBeVisible();
  await expect(page.getByTestId("clear-context-btn")).toBeVisible();
});

test("the Compact button uses a click-twice confirm gate", async ({ page }) => {
  await drive(page, "contextfull");
  const meter = page.getByTestId("context-meter");
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  const compactBtn = page.getByTestId("compact-btn");
  // First click arms.
  await compactBtn.click();
  await expect(compactBtn).toHaveText("Click again");
  // Second click fires.
  await compactBtn.click();
  // The mock emits a usageUpdated — meter drops to 4%.
  await expect(meter).toHaveText(/4%/);
});

test("the Clear context button uses a click-twice confirm gate", async ({
  page,
}) => {
  await drive(page, "contextfull");
  const meter = page.getByTestId("context-meter");
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  const clearBtn = page.getByTestId("clear-context-btn");
  // First click arms.
  await clearBtn.click();
  await expect(clearBtn).toHaveText("Click again");
  // Second click fires.
  await clearBtn.click();
  // The mock emits a usageUpdated — meter drops to 0%.
  await expect(meter).toHaveText(/0%/);
});
