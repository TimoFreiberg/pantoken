import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Mobile plan-handoff keeps the body independently scrollable and stacks the
// stable refusal plus implementation controls into usable touch targets.
test("plan-handoff.mobile feedback editor is focused and controls remain usable", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();
  const body = dialog.locator(".plan-body");
  await expect(body).toHaveCSS("overflow-y", "auto");
  await expect.poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  const feedback = dialog.getByRole("textbox", { name: /feedback/i });
  await expect(feedback).toBeFocused();
  const fieldBox = await feedback.boundingBox();
  expect(fieldBox).not.toBeNull();
  expect(fieldBox!.height).toBeGreaterThanOrEqual(44);

  const buttons = dialog.getByRole("button").filter({ hasText: /Refuse|Implement/ });
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual((await page.evaluate(() => innerWidth)) + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
});

test("plan-handoff preserves refusal draft across pending-dialog navigation", async ({ page }) => {
  await drive(page, "planhandoffpending");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await dialog.getByRole("textbox", { name: /feedback/i }).fill("mobile pending sentinel");
  await dialog.getByTitle("Next pending request").click();
  await dialog.getByTitle("Previous pending request").click();
  await expect(dialog.getByRole("textbox", { name: /feedback/i })).toHaveValue("mobile pending sentinel");
});

// The original request is then remotely resolved and replaced. Its request-scoped
// refusal draft must be removed rather than appearing on the replacement request.
test("plan-handoff refusal draft is cleared after request replacement", async ({ page }) => {
  await drive(page, "planhandoffpending");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Refuse", exact: true }).click();
  await dialog.getByRole("textbox", { name: /feedback/i }).fill("stale replacement sentinel");
  await expect(dialog.getByTitle("Next pending request")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /feedback/i })).toHaveValue("stale replacement sentinel");

  // The mock resolves request A at 5s and emits a distinct replacement request.
  const replacement = page.getByRole("dialog", { name: "Plan handoff (replacement)" });
  await expect(replacement).toBeVisible({ timeout: 9000 });
  await expect(replacement.getByRole("textbox", { name: /feedback/i })).toHaveCount(0);
  await expect(replacement.getByText("stale replacement sentinel")).toHaveCount(0);
  await expect(replacement.getByRole("button", { name: "Refuse", exact: true })).toBeVisible();
});

test("plan-handoff mobile has no horizontal overflow", async ({ page }) => {
  await drive(page, "planhandoff");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
});

// Facet badge renders on mobile when the facet is plan.
test("facet badge renders on mobile plan facet", async ({ page }) => {
  await drive(page, "planfacet");
  const summary = page.getByTestId("mobile-session-controls-trigger");
  await expect(summary).toBeVisible();
  await expect(summary.locator("span").nth(1)).toHaveText("Execute");
});
