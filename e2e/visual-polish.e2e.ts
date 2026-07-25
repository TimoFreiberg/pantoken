import { expect, test, type Locator, type Page } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// ─── Shared CSSOM-validation utilities ───────────────────────────────────
// Previously duplicated (in concept) across sidebar-visual-polish.e2e.ts and
// tool-card-bounds.e2e.ts. Consolidated here so both surfaces share one block.

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

async function normalizedProperty(
  locator: Locator,
  property: string,
  value: string,
): Promise<string> {
  return locator.evaluate(
    (element, input) => {
      const probe = document.createElement("span");
      probe.style.setProperty(input.property, input.value);
      element.append(probe);
      const normalized = getComputedStyle(probe).getPropertyValue(
        input.property,
      );
      probe.remove();
      return normalized;
    },
    { property, value },
  );
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
    const probeAttribute = "data-scrollbar-cascade-probe";
    const probeValue = Math.random().toString(36).slice(2);
    const probeSuffix = `[${probeAttribute}="${probeValue}"]`;
    const translatedRules: string[] = [];
    const declaration = (
      name: string,
      value: string,
      priority: string,
    ): string =>
      value ? `${name}: ${value}${priority ? " !important" : ""};` : "";

    const visit = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (
          rule instanceof CSSMediaRule &&
          !matchMedia(rule.conditionText).matches
        )
          continue;
        if (
          rule instanceof CSSSupportsRule &&
          !CSS.supports(rule.conditionText)
        )
          continue;
        if (rule instanceof CSSStyleRule) {
          for (const selector of rule.selectorText.split(",")) {
            const exact = selector.trim();
            if (!exact.endsWith(pseudoSelector)) continue;
            const base = exact.slice(0, -pseudoSelector.length).trim();
            try {
              if (!element.matches(base)) continue;
            } catch {
              continue;
            }

            const backgroundProperty = rule.style.backgroundColor
              ? "background-color"
              : "background";
            const declarations = [
              declaration(
                "--scrollbar-probe-background",
                rule.style.getPropertyValue(backgroundProperty),
                rule.style.getPropertyPriority(backgroundProperty),
              ),
              declaration(
                "--scrollbar-probe-radius",
                rule.style.borderRadius,
                rule.style.getPropertyPriority("border-radius"),
              ),
              declaration(
                "--scrollbar-probe-width",
                rule.style.width,
                rule.style.getPropertyPriority("width"),
              ),
            ].join("");
            if (declarations)
              translatedRules.push(`${base}${probeSuffix} { ${declarations} }`);
          }
        }
        if ("cssRules" in rule) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
    if (translatedRules.length === 0)
      throw new Error(`No scoped WebKit scrollbar rule for ${pseudoSelector}`);

    const probeStyle = document.createElement("style");
    probeStyle.textContent = translatedRules.join("\n");
    element.setAttribute(probeAttribute, probeValue);
    document.head.append(probeStyle);
    try {
      const computed = getComputedStyle(element);
      return {
        background: computed
          .getPropertyValue("--scrollbar-probe-background")
          .trim(),
        borderRadius: computed
          .getPropertyValue("--scrollbar-probe-radius")
          .trim(),
        width: computed.getPropertyValue("--scrollbar-probe-width").trim(),
      };
    } finally {
      probeStyle.remove();
      element.removeAttribute(probeAttribute);
    }
  }, pseudo);
}

async function height(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().height);
}

// ═══════════════════════════════════════════════════════════════════════════
// Sidebar visual polish (from sidebar-visual-polish.e2e.ts)
// ═══════════════════════════════════════════════════════════════════════════

test.describe("sidebar visual polish", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 320 });
    await gotoFresh(page);
  });

  test("short desktop rails share their surface and retain compact scrolling geometry", async ({
    page,
  }) => {
    await drive(page, "context");

    // The context script pushes flags/jobs/todos over the WS asynchronously, and the
    // right rail auto-opens once that data lands. Wait for the content to actually
    // render before measuring geometry — otherwise an empty .content (scrollHeight
    // === clientHeight) can race the assertion when this test runs in a batch.
    const rightRail = page.getByTestId("right-sidebar");
    await expect(rightRail).toHaveAttribute("data-open", "true");
    // Wait for the list items, not just the section shells: a <section> can be
    // "visible" (displayed, empty) before its WS data renders. The items prove the
    // flags (3 files), jobs (3), and todos (3) all arrived and laid out.
    await expect(rightRail.locator(".file-item")).toHaveCount(3);
    await expect(rightRail.locator(".job-item")).toHaveCount(3);
    await expect(rightRail.locator(".todo-item")).toHaveCount(3);

    const leftRail = page.getByTestId("sidebar");
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
    const contextHeaderDivider = await rightRail
      .locator(".top")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          style: style.borderBottomStyle,
          width: style.borderBottomWidth,
        };
      });
    expect(contextHeaderDivider).toEqual({ style: "none", width: "0px" });

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

    // Prove the CSSOM oracle follows selector applicability and the author cascade.
    const expectedLeftThumb = await normalizedColor(
      leftScroller,
      "color-mix(in srgb, var(--accent) 42%, transparent)",
    );
    const decoy = await leftScroller.evaluate((element) => {
      const style = document.createElement("style");
      style.dataset.scrollbarOracle = "decoy";
      style.textContent =
        ".list-decoy::-webkit-scrollbar-thumb { background: rgb(1, 2, 3); }";
      document.head.append(style);
      return element.className;
    });
    expect(decoy).toContain("list");
    expect(
      await normalizedColor(
        leftScroller,
        (await declaredWebkitStyle(leftScroller, "::-webkit-scrollbar-thumb"))
          .background,
      ),
    ).toBe(expectedLeftThumb);

    await leftScroller.evaluate((element) => {
      const style = document.createElement("style");
      const exactBase = Array.from(element.classList)
        .map((name) => `.${CSS.escape(name)}`)
        .join("");
      style.dataset.scrollbarOracle = "source-order";
      style.textContent = `
      ${exactBase}::-webkit-scrollbar-thumb { background: rgb(10, 11, 12); }
      ${exactBase}::-webkit-scrollbar-thumb { background: rgb(13, 14, 15); }
    `;
      document.head.append(style);
    });
    const sourceOrderWinner = await declaredWebkitStyle(
      leftScroller,
      "::-webkit-scrollbar-thumb",
    );
    expect(
      await normalizedColor(leftScroller, sourceOrderWinner.background),
    ).toBe("rgb(13, 14, 15)");

    await leftScroller.evaluate((element) => {
      const style = document.createElement("style");
      const exactBase = Array.from(element.classList)
        .map((name) => `.${CSS.escape(name)}`)
        .join("");
      style.dataset.scrollbarOracle = "specificity";
      style.textContent = `
      .sidebar ${exactBase}::-webkit-scrollbar-thumb { background: rgb(4, 5, 6); }
      ${exactBase}::-webkit-scrollbar-thumb { background: rgb(1, 2, 3); }
    `;
      document.head.append(style);
    });
    const specificityWinner = await declaredWebkitStyle(
      leftScroller,
      "::-webkit-scrollbar-thumb",
    );
    expect(
      await normalizedColor(leftScroller, specificityWinner.background),
    ).toBe("rgb(4, 5, 6)");
    // A partial winning declaration retains the effective radius from another rule.
    expect(specificityWinner.borderRadius).toBe("999px");

    await leftScroller.evaluate((element) => {
      const style = document.createElement("style");
      const exactBase = Array.from(element.classList)
        .map((name) => `.${CSS.escape(name)}`)
        .join("");
      style.dataset.scrollbarOracle = "important";
      style.textContent = `${exactBase}::-webkit-scrollbar-thumb { background: rgb(7, 8, 9) !important; }`;
      document.head.append(style);
    });
    const importantWinner = await declaredWebkitStyle(
      leftScroller,
      "::-webkit-scrollbar-thumb",
    );
    expect(await normalizedColor(leftScroller, importantWinner.background)).toBe(
      "rgb(7, 8, 9)",
    );
    expect(importantWinner.borderRadius).toBe("999px");
    await page.locator("style[data-scrollbar-oracle]").evaluateAll((styles) => {
      for (const style of styles) style.remove();
    });

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

  test("New session CTA has clear resting, hover, and focus treatment", async ({
    page,
  }) => {
    const button = page.getByTestId("sidebar-new-session").locator(".new-btn");
    const icon = button.locator(".plus");
    const expected = {
      background: await normalizedColor(button, "var(--highlight-soft)"),
      border: await normalizedColor(
        button,
        "color-mix(in srgb, var(--highlight) 30%, transparent)",
      ),
      focusRing: await normalizedProperty(
        button,
        "box-shadow",
        "0 0 0 2px color-mix(in srgb, var(--accent) 65%, transparent)",
      ),
      hoverBackground: await normalizedColor(button, "var(--highlight-hover)"),
      hoverBorder: await normalizedColor(
        button,
        "color-mix(in srgb, var(--highlight) 45%, transparent)",
      ),
      hoverText: await normalizedColor(button, "var(--highlight-text)"),
      iconColor: await normalizedColor(icon, "var(--highlight)"),
      iconHoverColor: await normalizedColor(icon, "var(--highlight-text)"),
      restingShadow: await normalizedProperty(
        button,
        "box-shadow",
        "0 1px 0 color-mix(in srgb, var(--text) 5%, transparent)",
      ),
      text: await normalizedColor(button, "var(--text)"),
    };

    // The visible label is "New session" (no ellipsis) with a leading +.
    await expect(button).toContainText("New session");
    await expect(button).not.toContainText("…");
    await expect(icon).toHaveText("+");

    const resting = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        boxShadow: style.boxShadow,
        color: style.color,
        fontWeight: style.fontWeight,
      };
    });
    expect(resting).toEqual({
      background: expected.background,
      border: expected.border,
      boxShadow: expected.restingShadow,
      color: expected.text,
      fontWeight: "550",
    });

    // The plus is inline text now — no boxed background, no fixed dimensions.
    const iconStyle = await icon.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
      };
    });
    expect(iconStyle).toEqual({
      background: "rgba(0, 0, 0, 0)",
      color: expected.iconColor,
    });

    await button.hover();
    await expect
      .poll(() =>
        button.evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe(expected.hoverBackground);
    await expect(button).toHaveCSS("border-top-color", expected.hoverBorder);
    await expect(button).toHaveCSS("color", expected.hoverText);
    await expect
      .poll(() => icon.evaluate((element) => getComputedStyle(element).color))
      .toBe(expected.iconHoverColor);

    await page.keyboard.press("Tab");
    await button.focus();
    await expect(button).toHaveCSS("box-shadow", expected.focusRing);
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
    // The ::after stripe has transition: background 120ms ease, so the computed
    // background can still read transparent before the dragging color applies.
    // Poll until the accent stripe paints, mirroring the focus check above.
    await expect
      .poll(async () => colorAlpha((await stripeStyle(handle)).background))
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.cursor))
      .toBe("col-resize");
    await page.mouse.up();
    await expect(handle).not.toHaveClass(/\bdragging\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool card bounds (from tool-card-bounds.e2e.ts)
// ═══════════════════════════════════════════════════════════════════════════

const OUTPUT_LIMIT = 50_000;
const TRUNCATION_MARKER = "\n… output truncated by pantoken";

test.describe("tool card bounds", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
    await page.evaluate(() => {
      const mock = (
        window as unknown as { __pantokenMock?: (script: string) => void }
      ).__pantokenMock;
      if (!mock) throw new Error("mock hook unavailable");
      mock("toolpolish");
    });
    await expect(
      page.locator(".tool").filter({ hasText: "Running tool" }),
    ).toBeVisible();
  });

  function card(page: Page, label: string): Locator {
    return page
      .locator(".tool")
      .filter({ has: page.getByText(label, { exact: true }) });
  }

  async function open(card: Locator): Promise<void> {
    await card.locator(":scope > .head").click();
    await expect(card.locator(":scope > .body")).toBeVisible();
  }

  test("header and detailed arguments stop at every configured boundary", async ({
    page,
  }) => {
    const exactHeader = card(page, "Header exact").locator(".arg");
    const overHeader = card(page, "Header over").locator(".arg");
    // The duration badge ("1ms") is nested inside .arg, so exclude it when
    // measuring the arg preview length.
    const argPreview = (loc: Locator) =>
      loc.evaluate((el) =>
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join(""),
      );
    expect(await argPreview(exactHeader)).toHaveLength(320);
    expect((await argPreview(exactHeader)).endsWith("…")).toBe(false);
    expect(await argPreview(overHeader)).toHaveLength(321);
    expect((await argPreview(overHeader)).endsWith("…")).toBe(true);

    const exactArgs = card(page, "Args exact 40");
    await open(exactArgs);
    await expect(exactArgs.locator(".arg-key")).toHaveCount(40);
    await expect(
      exactArgs.locator(".arg-key", { hasText: "exact_field_39" }),
    ).toHaveCount(1);
    await expect(exactArgs.locator(".args")).not.toContainText(
      "arguments omitted",
    );

    const args = card(page, "Bounded args");
    await open(args);
    const exactValue = args
      .locator(".arg-key", { hasText: "a_exact_value" })
      .locator("xpath=following-sibling::pre[1]");
    const overValue = args
      .locator(".arg-key", { hasText: "b_over_value" })
      .locator("xpath=following-sibling::pre[1]");
    expect((await exactValue.textContent())?.length).toBe(20_000);
    await expect(exactValue).not.toContainText("output truncated by pantoken");
    await expect(overValue).toContainText("output truncated by pantoken");
    await expect(overValue).not.toContainText("ARG_TAIL");
    const renderedKeys = args.locator(".arg-key");
    await expect(renderedKeys).toHaveCount(40);
    await expect(args.locator(".arg-key", { hasText: "z_field_37" })).toHaveCount(
      1,
    );
    await expect(args.locator(".arg-key", { hasText: "z_field_38" })).toHaveCount(
      0,
    );
    await expect(args.locator(".args")).toContainText(
      "… 1 more arguments omitted",
    );

    const copy = args.getByRole("button", {
      name: "Copy full arguments",
      exact: true,
    });
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("ARG_TAIL");
    const copiedArgs = JSON.parse(
      await page.evaluate(() => navigator.clipboard.readText()),
    ) as Record<string, unknown>;
    expect(Object.keys(copiedArgs)).toHaveLength(41);
    expect(copiedArgs.b_over_value).toBe(`${"Y".repeat(20_000)}ARG_TAIL`);
    expect(copiedArgs.z_field_38).toBe(38);
  });

  test("plain and multi-block output stay bounded while Copy retains every byte", async ({
    page,
  }) => {
    const exact = card(page, "Output exact");
    await open(exact);
    const exactOut = exact.locator(".out");
    expect((await exactOut.textContent())?.length).toBe(50_000);
    await expect(exactOut).not.toContainText("output truncated by pantoken");

    for (const [label, expected] of [
      ["Output over", `${"P".repeat(OUTPUT_LIMIT)}OUTPUT_TAIL`],
      ["Output blocks", `${"A".repeat(30_000)}${"B".repeat(20_000)}MULTI_TAIL`],
    ] as const) {
      const bounded = card(page, label);
      await open(bounded);
      const output = bounded.locator(".out");
      await expect(output).toContainText("output truncated by pantoken");
      expect(await output.textContent()).toBe(
        `${expected.slice(0, OUTPUT_LIMIT)}${TRUNCATION_MARKER}`,
      );
      const copy = bounded.getByRole("button", { name: "Copy", exact: true });
      await expect(copy).toHaveAttribute("title", /full output/i);
      await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(expected);
    }
  });

  test("streamed tool text is bounded without changing the tool state", async ({
    page,
  }) => {
    const running = card(page, "Running tool");
    await open(running);
    const stream = running.locator(".stream");
    expect(await stream.textContent()).toBe(
      `${"S".repeat(OUTPUT_LIMIT)}${TRUNCATION_MARKER}`,
    );
    await running
      .getByRole("button", { name: "Copy full progress", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${"S".repeat(OUTPUT_LIMIT)}STREAM_TAIL`);
    await expect(running).toHaveClass(/running/);
    const state = await (await page.request.get("/debug/state")).text();
    expect(state).toContain("STREAM_TAIL");
  });

  test("completed, running, failed, and interrupted statuses stay distinct", async ({
    page,
  }) => {
    const completed = card(page, "Header exact");
    await expect(completed.locator(":scope > .head .status")).toHaveCount(0);
    await expect(completed.locator(":scope > .head")).toHaveAccessibleName(
      /completed/i,
    );

    const running = card(page, "Running tool");
    await expect(running.locator(":scope > .head .status")).toHaveText("○");
    await expect(running.locator(":scope > .head")).toHaveAccessibleName(
      /running/i,
    );

    const failed = card(page, "Failed tool");
    const failureMark = failed.locator(":scope > .head .status");
    await expect(failureMark).toHaveText("✕");
    expect(
      await failureMark.evaluate((mark) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--danger)";
        document.body.append(probe);
        const matches =
          getComputedStyle(mark).color === getComputedStyle(probe).color;
        probe.remove();
        return matches;
      }),
    ).toBe(true);
    await expect(failed.locator(":scope > .head")).toHaveAccessibleName(
      /failed/i,
    );

    const interrupted = card(page, "Interrupted tool");
    await expect(interrupted.locator(":scope > .head .status")).toHaveCount(0);
    await expect(interrupted.locator(".status-text")).toHaveText("interrupted");
    await expect(interrupted.locator(".status-text")).toBeVisible();
    await expect(interrupted.locator(":scope > .head")).toHaveAccessibleName(
      /interrupted/i,
    );
    await open(interrupted);
    await expect(interrupted.locator(".out")).toHaveText(
      "partial interrupted output",
    );
  });

  test("tool names align to the same left coordinate across all statuses", async ({
    page,
  }) => {
    const names = page.locator(".tool .head .name");
    const xs = await names.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().left),
    );
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    expect(max - min).toBeLessThanOrEqual(1);
  });

  test("completed tool has an empty status-slot and no visible status glyph", async ({
    page,
  }) => {
    const completed = card(page, "Header exact");
    await expect(completed.locator(":scope > .head > .status-slot")).toHaveCount(
      1,
    );
    await expect(completed.locator(":scope > .head .status")).toHaveCount(0);
  });

  test("duration is hidden at rest and revealed on hover/focus", async ({
    page,
  }) => {
    const completed = card(page, "Header exact");
    const duration = completed.locator(".duration");
    await expect(duration).toHaveCSS("opacity", "0");
    await completed.locator(":scope > .head").hover();
    await expect(duration).toHaveCSS("opacity", "1");
    // Move away — duration hides again
    await page.mouse.move(0, 0);
    await expect(duration).toHaveCSS("opacity", "0");
  });

  test("revealing duration does not change header width or name position", async ({
    page,
  }) => {
    const completed = card(page, "Header exact");
    const head = completed.locator(":scope > .head");
    const name = completed.locator(".name");
    const before = {
      headWidth: (await head.boundingBox())!.width,
      nameX: (await name.boundingBox())!.x,
    };
    await head.hover();
    const after = {
      headWidth: (await head.boundingBox())!.width,
      nameX: (await name.boundingBox())!.x,
    };
    expect(after.headWidth).toBe(before.headWidth);
    expect(after.nameX).toBe(before.nameX);
  });

  test("keyboard focus on header reveals duration", async ({ page }) => {
    const completed = card(page, "Header exact");
    const duration = completed.locator(".duration");
    await completed.locator(":scope > .head").focus();
    await expect(duration).toHaveCSS("opacity", "1");
  });

  test("duration contributes 'took' to the header accessible name", async ({
    page,
  }) => {
    const completed = card(page, "Header exact");
    await expect(completed.locator(":scope > .head")).toHaveAccessibleName(
      /took \d+ms/i,
    );
  });

  test("mobile: duration hidden when collapsed, shown when expanded; header ≥44px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const completed = card(page, "Header exact");
    const duration = completed.locator(".duration");
    // Collapsed → hidden
    await expect(duration).toHaveCSS("display", "none");
    const headBox = await completed.locator(":scope > .head").boundingBox();
    expect(headBox!.height).toBeGreaterThanOrEqual(44);
    // Expanded → shown (always-on, not hover-gated on mobile)
    await completed.locator(":scope > .head").click();
    await expect(completed.locator(":scope > .body")).toBeVisible();
    await expect(duration).toHaveCSS("opacity", "1");
  });

  test("duration sits within the header row, not below it (#56)", async ({
    page,
  }) => {
    const completed = card(page, "Header exact");
    const head = completed.locator(":scope > .head");
    const duration = completed.locator(".duration");

    // Collapsed + hover: duration is within the head's vertical bounds.
    await head.hover();
    await expect(duration).toHaveCSS("opacity", "1");
    let headBox = (await head.boundingBox())!;
    let durBox = (await duration.boundingBox())!;
    expect(durBox.y + durBox.height).toBeLessThanOrEqual(
      headBox.y + headBox.height + 1,
    );
    expect(durBox.y).toBeGreaterThanOrEqual(headBox.y - 1);

    // Expanded + hover: duration still sits within the head, never reaching the body.
    await head.click();
    const body = completed.locator(":scope > .body");
    await expect(body).toBeVisible();
    await head.hover();
    await expect(duration).toHaveCSS("opacity", "1");
    headBox = (await head.boundingBox())!;
    durBox = (await duration.boundingBox())!;
    const bodyBox = (await body.boundingBox())!;
    expect(durBox.y + durBox.height).toBeLessThanOrEqual(
      headBox.y + headBox.height + 1,
    );
    expect(durBox.y).toBeGreaterThanOrEqual(headBox.y - 1);
    // Direct AC.2 guard: the duration's bottom must not reach the body's top.
    expect(durBox.y + durBox.height).toBeLessThanOrEqual(bodyBox.y + 1);
  });
});
