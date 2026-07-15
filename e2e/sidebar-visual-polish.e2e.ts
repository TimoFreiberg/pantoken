import { expect, test, type Locator } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

type BoxMetrics = {
  clientHeight: number;
  scrollHeight: number;
  padding: [number, number, number, number];
  scrollbarColor: string;
  scrollbarWidth: string;
};

async function boxMetrics(locator: Locator): Promise<BoxMetrics> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      padding: [
        parseFloat(style.paddingTop),
        parseFloat(style.paddingRight),
        parseFloat(style.paddingBottom),
        parseFloat(style.paddingLeft),
      ],
      scrollbarColor: style.scrollbarColor,
      scrollbarWidth: style.scrollbarWidth,
    };
  });
}

async function stripeStyle(handle: Locator): Promise<{
  background: string;
  centerOffset: number;
  width: number;
}> {
  return handle.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    const width = parseFloat(style.width);
    const transform = new DOMMatrixReadOnly(style.transform);
    const stripeCenter = parseFloat(style.left) + transform.m41 + width / 2;
    return {
      background: style.backgroundColor,
      centerOffset: stripeCenter - element.clientWidth / 2,
      width,
    };
  });
}

function scrollbarColors(value: string): [string, string] {
  const colors = value.match(
    /(?:rgba?|color)\([^)]*\)|transparent|#[\da-f]+/gi,
  );
  expect(colors, `expected a thumb and track color in ${value}`).toHaveLength(
    2,
  );
  return colors as [string, string];
}

async function normalizedColor(
  locator: Locator,
  color: string,
): Promise<string> {
  return locator.evaluate((element, value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    element.append(probe);
    const normalized = getComputedStyle(probe).color;
    probe.remove();
    return normalized;
  }, color);
}

function colorAlpha(color: string): number {
  const normalized = color.trim().toLowerCase();
  if (normalized === "transparent") return 0;

  if (normalized.startsWith("#")) {
    if (normalized.length === 5)
      return parseInt(normalized.slice(4, 5).repeat(2), 16) / 255;
    if (normalized.length === 9)
      return parseInt(normalized.slice(7, 9), 16) / 255;
    return 1;
  }

  const body = normalized.slice(
    normalized.indexOf("(") + 1,
    normalized.lastIndexOf(")"),
  );
  const slashAlpha = body.match(/\/\s*([\d.]+)(%)?\s*$/);
  if (slashAlpha) {
    const value = Number(slashAlpha[1]);
    return slashAlpha[2] ? value / 100 : value;
  }
  if (normalized.startsWith("rgba(")) {
    const channels = body.split(",");
    if (channels.length === 4) return Number(channels[3]!.trim());
  }
  return 1;
}

async function webkitScrollbarStyle(locator: Locator): Promise<{
  thumbBackground: string;
  thumbRadius: string;
  trackBackground: string;
  width: string;
}> {
  return locator.evaluate((element) => {
    const scrollbar = getComputedStyle(element, "::-webkit-scrollbar");
    const track = getComputedStyle(element, "::-webkit-scrollbar-track");
    const thumb = getComputedStyle(element, "::-webkit-scrollbar-thumb");
    return {
      thumbBackground: thumb.backgroundColor,
      thumbRadius: thumb.borderRadius,
      trackBackground: track.backgroundColor,
      width: scrollbar.width,
    };
  });
}

async function declaredWebkitStyle(
  locator: Locator,
  pseudo: string,
): Promise<{ background: string; borderRadius: string; width: string }> {
  return locator.evaluate((element, pseudoSelector) => {
    const marker = element.classList.contains("list") ? ".list" : ".content";
    const visit = (rules: CSSRuleList): CSSStyleDeclaration | null => {
      for (const rule of Array.from(rules)) {
        if (
          rule instanceof CSSStyleRule &&
          rule.selectorText
            .split(",")
            .some(
              (selector) =>
                selector.includes(marker) &&
                selector.trim().endsWith(pseudoSelector),
            )
        )
          return rule.style;
        if ("cssRules" in rule) {
          const nested = visit((rule as CSSGroupingRule).cssRules);
          if (nested) return nested;
        }
      }
      return null;
    };
    for (const sheet of Array.from(document.styleSheets)) {
      const style = visit(sheet.cssRules);
      if (style)
        return {
          background: style.backgroundColor || style.background,
          borderRadius: style.borderRadius,
          width: style.width,
        };
    }
    throw new Error(`No scoped WebKit scrollbar rule for ${pseudoSelector}`);
  }, pseudo);
}

async function height(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().height);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 320 });
  await gotoFresh(page);
});

test("short desktop rails share their surface and retain compact scrolling geometry", async ({
  page,
}) => {
  await drive(page, "context");

  const leftRail = page.getByTestId("sidebar");
  const rightRail = page.getByTestId("right-sidebar");
  const [leftStyle, rightStyle] = await Promise.all([
    leftRail.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        outerBorder: style.borderRightWidth,
      };
    }),
    rightRail.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        outerBorder: style.borderLeftWidth,
      };
    }),
  ]);
  expect(leftStyle.background).toBe(rightStyle.background);
  expect(leftStyle.outerBorder).toBe("0px");
  expect(rightStyle.outerBorder).toBe("0px");

  const leftScroller = leftRail.locator(".list");
  const rightScroller = rightRail.locator(".content");
  const [left, right] = await Promise.all([
    boxMetrics(leftScroller),
    boxMetrics(rightScroller),
  ]);

  for (const [metrics, scroller] of [
    [left, leftScroller],
    [right, rightScroller],
  ] as const) {
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.scrollbarWidth).toBe("thin");
    const [thumb, track] = scrollbarColors(metrics.scrollbarColor);
    expect(thumb).toBe(
      await normalizedColor(
        scroller,
        "color-mix(in srgb, var(--accent) 45%, transparent)",
      ),
    );
    expect(colorAlpha(track)).toBe(0);
  }

  for (const scroller of [leftScroller, rightScroller]) {
    const expectedThumb = await normalizedColor(
      scroller,
      "color-mix(in srgb, var(--accent) 42%, transparent)",
    );
    const expectedHoverThumb = await normalizedColor(
      scroller,
      "color-mix(in srgb, var(--accent) 62%, transparent)",
    );
    const resting = await webkitScrollbarStyle(scroller);
    expect(resting.width).toBe("6px");
    expect(resting.thumbBackground).toBe(expectedThumb);
    expect(colorAlpha(resting.thumbBackground)).toBeGreaterThan(0);
    expect(resting.thumbRadius).toBe("999px");
    expect(colorAlpha(resting.trackBackground)).toBe(0);

    // Chromium exposes the resting WebKit pseudo styles above, but not the active
    // scrollbar-thumb hover state to pointer automation. Inspect every scoped fallback
    // rule through CSSOM so removing an individual declaration remains observable.
    const [declaredScrollbar, declaredTrack, declaredThumb, declaredHover] =
      await Promise.all([
        declaredWebkitStyle(scroller, "::-webkit-scrollbar"),
        declaredWebkitStyle(scroller, "::-webkit-scrollbar-track"),
        declaredWebkitStyle(scroller, "::-webkit-scrollbar-thumb"),
        declaredWebkitStyle(scroller, "::-webkit-scrollbar-thumb:hover"),
      ]);
    expect(declaredScrollbar.width).toBe("6px");
    expect(
      colorAlpha(await normalizedColor(scroller, declaredTrack.background)),
    ).toBe(0);
    expect(await normalizedColor(scroller, declaredThumb.background)).toBe(
      expectedThumb,
    );
    expect(declaredThumb.borderRadius).toBe("999px");
    expect(await normalizedColor(scroller, declaredHover.background)).toBe(
      expectedHoverThumb,
    );
    expect(expectedHoverThumb).not.toBe(expectedThumb);
  }

  // Assert the deliberate compact geometry, including the shallow nesting step.
  expect(left.padding[1]).toBe(9);
  expect(left.padding[3]).toBe(9);
  const nesting = await leftRail
    .locator(".group ul")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
      };
    });
  expect(nesting.left).toBe(7);
  expect(nesting.left).toBeLessThan(left.padding[3]);
  expect(nesting.right).toBe(3);

  const sectionPadding = await rightRail
    .locator(".section")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
    });
  expect(sectionPadding).toEqual([16, 16]);

  const projectHeight = await height(leftRail.locator(".group-toggle").first());
  const rowHeight = await height(leftRail.locator(".row").first());
  for (const value of [projectHeight, rowHeight]) {
    expect(value).toBeGreaterThanOrEqual(30);
    expect(value).toBeLessThanOrEqual(36);
  }
  expect(Math.abs(projectHeight - rowHeight)).toBeLessThanOrEqual(4);
});

test("resize handles paint a centered stripe for focus and drag feedback", async ({
  page,
}) => {
  const handles = [
    page.getByRole("separator", { name: "Resize sessions sidebar" }),
    page.getByRole("separator", { name: "Resize context panel" }),
  ];

  for (const handle of handles) {
    const resting = await stripeStyle(handle);
    expect(resting.width).toBe(2);
    expect(Math.abs(resting.centerOffset)).toBeLessThanOrEqual(0.01);
    expect(colorAlpha(resting.background)).toBe(0);

    await handle.focus();
    await expect
      .poll(async () => colorAlpha((await stripeStyle(handle)).background))
      .toBeGreaterThan(0);
    expect(colorAlpha((await stripeStyle(handle)).background)).toBeGreaterThan(
      0,
    );
  }

  const handle = handles[0]!;
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 120);
  await page.mouse.down();
  await expect(handle).toHaveClass(/\bdragging\b/);
  expect(colorAlpha((await stripeStyle(handle)).background)).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.cursor))
    .toBe("col-resize");
  await page.mouse.up();
  await expect(handle).not.toHaveClass(/\bdragging\b/);
});
