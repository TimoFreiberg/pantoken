import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the picker lists sessions and switches the active one", async ({
  page,
}) => {
  const trigger = page.locator(".trigger");
  // the trigger shows the active (greeting) session's title
  await expect(trigger).toContainText("Wire up the WebSocket bridge");

  await trigger.click();

  // the panel lists the other mock sessions (one named, one preview-only)
  await expect(page.getByText("Explore the fold reducer")).toBeVisible();
  await expect(page.getByText("quick scratch session")).toBeVisible();

  // switching swaps the transcript to the chosen session's history
  await page.getByText("Explore the fold reducer").click();
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
  // and the previous session's content is gone
  await expect(page.getByText("Add a /health route to the server")).toHaveCount(
    0,
  );
  // the trigger now reflects the switched-to session
  await expect(page.locator(".trigger")).toContainText(
    "Explore the fold reducer",
  );
});

test("new session clears the transcript", async ({ page }) => {
  await page.locator(".trigger").click();
  await page.getByRole("button", { name: "+ New" }).click();
  await expect(
    page.getByText("No messages yet", { exact: false }),
  ).toBeVisible();
});
