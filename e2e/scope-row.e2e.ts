import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("scope controls render once in a compact row above the composer", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const scope = page.getByTestId("scope-row");
  const surface = page.getByTestId("composer-surface");
  await expect(page.getByTestId("draft-setup")).toHaveCount(0);
  await expect(page.getByTestId("draft-project-control")).toHaveCount(1);
  await expect(scope.getByTestId("draft-project-control")).toHaveCount(1);
  await expect(scope.getByTestId("draft-worktree-control")).toHaveCount(1);

  const metrics = await scope.evaluate((element) => {
    const css = getComputedStyle(element);
    const pageBackground = getComputedStyle(document.body).backgroundColor;
    const row = element.getBoundingClientRect();
    const card = document
      .querySelector(".composer-surface")!
      .getBoundingClientRect();
    return {
      background: css.backgroundColor,
      pageBackground,
      radius: css.borderTopLeftRadius,
      height: row.height,
      belowCard: row.bottom > card.top + 0.5,
      insideCard: element.closest(".composer-surface") !== null,
      marginBottom: css.marginBottom,
    };
  });
  expect(metrics.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(metrics.background).not.toBe(metrics.pageBackground);
  expect(metrics.radius).not.toBe("0px");
  expect(metrics.height).toBeLessThanOrEqual(34);
  expect(metrics.belowCard).toBe(false);
  expect(metrics.insideCard).toBe(false);
  expect(metrics.marginBottom).toBe("0px");
  await expect(scope.locator(".chip").first()).toHaveCSS("font-size", "12px");
  await expect(surface).toBeVisible();

  const status = page.getByTestId("composer-status-row");
  await expect(status.getByTestId("draft-project-control")).toHaveCount(0);
  await expect(status.getByTestId("draft-worktree-control")).toHaveCount(0);
  await expect(status.getByTestId("permission-badge")).toBeVisible();
  await expect(status.getByTestId("facet-badge")).toBeVisible();
  await expect(status.getByTestId("model-badge")).toBeVisible();
});

test("scope controls preserve picker exclusion and worktree branch behavior", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();

  const project = page.getByTestId("draft-project-control");
  const worktree = page.getByTestId("draft-worktree-control");
  await project.click();
  const dirPicker = page.getByRole("dialog", {
    name: "Choose project directory",
  });
  await expect(dirPicker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dirPicker).toBeHidden();

  await worktree.click();
  const branch = page.getByTestId("draft-branch-control");
  await expect(worktree).toHaveAttribute("aria-pressed", "true");
  await expect(branch).toBeVisible();
  await branch.click();
  await expect(
    page.getByRole("listbox", { name: "Select base branch" }),
  ).toBeVisible();
  await expect(dirPicker).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("listbox", { name: "Select base branch" }),
  ).toBeHidden();
  await project.click();
  await expect(dirPicker).toBeVisible();
  await expect(
    page.getByRole("listbox", { name: "Select base branch" }),
  ).toBeHidden();
});
