import { expect, test } from "@playwright/test";
import { gotoFresh, openRightSidebar, openSidebar } from "./helpers.js";

const LEFT_KEY: string = "pantoken.sidebarWidth";
const RIGHT_KEY: string = "pantoken.rightSidebarWidth";

async function clearWidths(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(({ left, right }) => {
    localStorage.removeItem(left);
    localStorage.removeItem(right);
  }, { left: LEFT_KEY, right: RIGHT_KEY });
}

async function width(page: import("@playwright/test").Page, testid: string): Promise<number> {
  return page.getByTestId(testid).evaluate((el) => el.getBoundingClientRect().width);
}

test.describe("desktop sidebar resize", () => {
  test.beforeEach(async ({ page }) => {
    await clearWidths(page);
    await gotoFresh(page);
  });

  test("dragging the sessions sidebar handle changes its width", async ({ page }) => {
    const sidebar = page.getByTestId("sidebar");
    const handle = page.getByRole("separator", { name: "Resize sessions sidebar" });
    const before = await width(page, "sidebar");
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 200);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + 200);
    await page.mouse.up();
    await expect.poll(() => width(page, "sidebar")).toBeGreaterThan(before + 50);
    await expect(sidebar).toHaveAttribute("data-open", "true");
    expect(await width(page, "right-sidebar")).toBeGreaterThan(0);
  });

  test("dragging the context panel handle changes only the right width", async ({ page }) => {
    const leftBefore = await width(page, "sidebar");
    const rightBefore = await width(page, "right-sidebar");
    const handle = page.getByRole("separator", { name: "Resize context panel" });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 200);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 - 80, box!.y + 200);
    await page.mouse.up();
    await expect.poll(() => width(page, "right-sidebar")).toBeGreaterThan(rightBefore + 50);
    expect(await width(page, "sidebar")).toBeCloseTo(leftBefore, 0);
  });

  test("both chosen widths survive reload", async ({ page }) => {
    const left = page.getByRole("separator", { name: "Resize sessions sidebar" });
    const leftBox = await left.boundingBox();
    expect(leftBox).not.toBeNull();
    await page.mouse.move(leftBox!.x + 6, leftBox!.y + 200);
    await page.mouse.down();
    await page.mouse.move(leftBox!.x + 56, leftBox!.y + 200);
    await page.mouse.up();

    const right = page.getByRole("separator", { name: "Resize context panel" });
    const rightBox = await right.boundingBox();
    expect(rightBox).not.toBeNull();
    await page.mouse.move(rightBox!.x + 6, rightBox!.y + 200);
    await page.mouse.down();
    await page.mouse.move(rightBox!.x - 44, rightBox!.y + 200);
    await page.mouse.up();

    const chosen = { left: await width(page, "sidebar"), right: await width(page, "right-sidebar") };
    const stored = await page.evaluate(({ leftKey, rightKey }) => ({
      left: Number(localStorage.getItem(leftKey)),
      right: Number(localStorage.getItem(rightKey)),
    }), { leftKey: LEFT_KEY, rightKey: RIGHT_KEY });
    expect(stored.left).toBeCloseTo(chosen.left, 0);
    expect(stored.right).toBeCloseTo(chosen.right, 0);
    await page.reload();
    await expect.poll(() => width(page, "sidebar")).toBeCloseTo(chosen.left, 0);
    await expect.poll(() => width(page, "right-sidebar")).toBeCloseTo(chosen.right, 0);
  });

  test("resize handles expose accessibility metadata and keyboard controls", async ({ page }) => {
    for (const name of ["Resize sessions sidebar", "Resize context panel"]) {
      const handle = page.getByRole("separator", { name });
      await expect(handle).toHaveAttribute("aria-orientation", "vertical");
      await expect(handle).toHaveAttribute("title", new RegExp(name));
      await expect(handle).toHaveAttribute("aria-valuemin", "200");
      await expect(handle).toHaveAttribute("aria-valuemax", /[0-9]+/);
      await expect(handle).toHaveAttribute("aria-valuenow", /[0-9]+/);
    }
    const handle = page.getByRole("separator", { name: "Resize sessions sidebar" });
    const before = await width(page, "sidebar");
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => width(page, "sidebar")).toBeGreaterThan(before + 10);
    await page.keyboard.press("Home");
    await expect.poll(() => width(page, "sidebar")).toBeCloseTo(200, 0);

    const right = page.getByRole("separator", { name: "Resize context panel" });
    const rightBefore = await width(page, "right-sidebar");
    await right.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => width(page, "right-sidebar")).toBeGreaterThan(rightBefore + 10);
    await page.keyboard.press("Home");
    await expect.poll(() => width(page, "right-sidebar")).toBeCloseTo(200, 0);
    await page.keyboard.press("End");
    await expect.poll(() => width(page, "right-sidebar")).toBeLessThanOrEqual(540);
  });

  test("pointer cancellation and window blur release the resize interaction", async ({ page }) => {
    const handle = page.getByRole("separator", { name: "Resize sessions sidebar" });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 6, box!.y + 200);
    await page.mouse.down();
    await page.evaluate(() => {
      document.querySelector('[role="separator"]')?.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => ({ cursor: document.documentElement.style.cursor, select: document.documentElement.style.userSelect }))).toEqual({ cursor: "", select: "" });

    await page.mouse.move(box!.x + 6, box!.y + 200);
    await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => ({ cursor: document.documentElement.style.cursor, select: document.documentElement.style.userSelect }))).toEqual({ cursor: "", select: "" });
  });
});

