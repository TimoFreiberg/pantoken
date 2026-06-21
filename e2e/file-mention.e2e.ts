import { expect, test, type Page } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// @-mention autocomplete in a NEW-SESSION DRAFT. A draft has no session yet, so its files
// can't come from the pushed index (that reflects the previously-focused session's cwd — the
// wrong project). The composer instead searches via the server `fd` fallback scoped to the
// draft's target cwd. The mock surfaces a synthetic `<cwd>/DRAFT-CWD.md` whenever a cwd is
// passed, so its presence proves the draft cwd flowed Composer → store → hub → driver.

const ta = (page: Page) => page.locator(".composer-wrap textarea");

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a draft's @-mention searches the draft cwd via the server; a real session doesn't", async ({
  page,
}) => {
  const box = ta(page);

  // A real (focused) session never fires the server fallback — its small index isn't
  // truncated — so the cwd-only marker is absent.
  await box.click();
  await page.keyboard.type("@DRAFT-CWD");
  await expect(page.getByTestId("file-menu")).toHaveCount(0);
  await box.fill("");

  // A new-session draft searches via the server fallback scoped to its target cwd, so the
  // cwd-derived marker appears — and ordinary fixture files still resolve too.
  await page.getByRole("button", { name: "New session…" }).click();
  await box.click();
  await page.keyboard.type("@DRAFT-CWD");
  const menu = page.getByTestId("file-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("DRAFT-CWD.md", { exact: false })).toBeVisible();

  await box.fill("");
  await box.click();
  await page.keyboard.type("@Composer");
  await expect(
    menu.getByText("client/src/components/Composer.svelte"),
  ).toBeVisible();
});
