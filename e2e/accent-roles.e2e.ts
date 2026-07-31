import { expect, test, type Locator, type Page } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function resolvedToken(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

function rgb(color: string): number[] {
  return (
    color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number) ?? [0, 0, 0]
  );
}

function luminance(color: string): number {
  const channels = rgb(color).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function colorContrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

async function contrastRatio(
  foreground: Locator,
  background: Locator,
): Promise<number> {
  const [fg, bg] = await Promise.all([
    foreground.evaluate((el) => getComputedStyle(el).color),
    background.evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  return colorContrast(fg, bg);
}

test("gold actions stay distinct from nickel structure in both themes", async ({
  page,
}) => {
  await drive(page, "confirm");
  const primary = page.locator(".btn.primary").first();
  await expect(primary).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page
      .locator("html")
      .evaluate((el, value) => el.setAttribute("data-theme", value), theme);
    const [accent, highlight] = await Promise.all([
      resolvedToken(page, "--accent"),
      resolvedToken(page, "--highlight"),
    ]);

    // The action color must differ from the structural color…
    expect(highlight).not.toBe(accent);
    // …and the primary button text must clear the WCAG AA threshold on it.
    expect(await contrastRatio(primary, primary)).toBeGreaterThanOrEqual(4.5);
  }
});

test("paper, nickel, and prompt surfaces keep a visible hierarchy", async ({
  page,
}) => {
  await expect(page.locator(".row.user .bubble").first()).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page
      .locator("html")
      .evaluate((el, value) => el.setAttribute("data-theme", value), theme);
    const [canvas, sidebarSurface, promptSurface, cardSurface, mutedText] =
      await Promise.all([
        resolvedToken(page, "--bg"),
        resolvedToken(page, "--sidebar-bg"),
        resolvedToken(page, "--prompt-bg"),
        resolvedToken(page, "--surface"),
        resolvedToken(page, "--text-muted"),
      ]);

    expect(colorContrast(mutedText, sidebarSurface)).toBeGreaterThanOrEqual(
      4.5,
    );
    const ordered =
      theme === "light"
        ? [cardSurface, canvas, sidebarSurface, promptSurface]
        : [promptSurface, cardSurface, sidebarSurface, canvas];
    const lightness = ordered.map(luminance);
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i - 1]!).toBeGreaterThan(lightness[i]!);
      expect(
        colorContrast(ordered[i - 1]!, ordered[i]!),
      ).toBeGreaterThanOrEqual(1.05);
    }
  }
});
