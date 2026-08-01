import { expect, test } from "@playwright/test";
import { driveLive, driveLiveRecovery, gotoFreshLive } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

test("rewind restores the live prompt in the composer", async ({ page }) => {
  await driveLive(page, "rewind-ready");
  const rewind = page.getByRole("button", { name: "Rewind to this prompt" });
  await expect(rewind).toBeVisible({ timeout: 10_000 });
  await rewind.click();
  await rewind.click();
  await expect(page.getByPlaceholder("Message pantoken…")).toHaveValue(
    "preserve this prompt",
    { timeout: 10_000 },
  );
  await expect(page.locator(".row.user")).toHaveCount(1);
});

test("rewind rejection remains visible and preserves the editor state", async ({ page }) => {
  await driveLive(page, "rewind-rejection");
  const rewind = page.getByRole("button", { name: "Rewind to this prompt" });
  await expect(rewind).toBeVisible({ timeout: 10_000 });
  await rewind.click();
  await rewind.click();
  await expect(page.getByRole("alert")).toContainText(/rewind rejected|POST \/rewind failed/i, {
    timeout: 10_000,
  });
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();
  await expect(page.locator(".row.user")).toHaveCount(1);
});

test("a controlled reconnect reseeds without leaving a running indicator", async ({ page }) => {
  await driveLiveRecovery(page, "reconnect-reseed");
  await expect(page.locator(".row.user")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("working-indicator")).toHaveCount(0, { timeout: 10_000 });
});

test("model errors are visible again after controlled reseed", async ({ page }) => {
  await driveLiveRecovery(page, "action-error");
  const notice = page.locator(".row.notice.error");
  await expect(notice).toContainText("E500: internal provider failure", { timeout: 10_000 });
  await expect(notice).toHaveCount(1);
});
