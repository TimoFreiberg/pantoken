import { expect, test } from "@playwright/test";
import {
  PROMPT_MAP_RAIL_INSET,
  PROMPT_MAP_TICK_PITCH,
} from "../client/src/lib/prompt-map.js";
import { drive, gotoFresh, scrollUpViaKeyboard, waitForSettledWorkBlocks } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoFresh(page);
});

test("desktop prompt map shows one accessible tick per prompt and previews", async ({ page }) => {
  const map = page.getByTestId("prompt-map");
  await expect(map).toHaveCount(0);

  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 2);
  await expect(map).toBeVisible();
  await expect(map.getByTestId("prompt-map-tick")).toHaveCount(2);

  const tick = map.getByTestId("prompt-map-tick").last();
  await tick.focus();
  await expect(page.getByTestId("prompt-map-preview")).toContainText("Show me the streamed reply");
  await expect(page.getByTestId("prompt-map-preview")).toContainText("That confirms it");
  await expect(tick).toHaveAttribute("aria-label", /Prompt 2 of 2/);

  // The selected ticks form a compact, vertically centered cluster. Poll until the rail
  // and every mark have real boxes, then assert the count-based compact bound, the
  // [inset, railHeight - inset] band on every tick center, and the centered cluster.
  const readCluster = async () => {
    const railBox = await map.locator(".desktop-rail").boundingBox();
    const boxes = await map.getByTestId("prompt-map-tick").evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, height: rect.height };
      }),
    );
    if (!railBox || boxes.length === 0 || boxes.some((b) => b.height === 0)) return null;
    const centers = boxes.map((b) => b.top - railBox.y + b.height / 2);
    return {
      railHeight: railBox.height,
      centers,
      span: Math.max(...centers) - Math.min(...centers),
      clusterCenter: (Math.max(...centers) + Math.min(...centers)) / 2,
      count: centers.length,
    };
  };
  let cluster: Awaited<ReturnType<typeof readCluster>> | null = null;
  await expect
    .poll(
      async () => {
        cluster = await readCluster();
        return cluster;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();
  const c = cluster!;
  const usableHeight = Math.max(0, c.railHeight - 2 * PROMPT_MAP_RAIL_INSET);
  const compactBound = Math.min(
    usableHeight,
    PROMPT_MAP_TICK_PITCH * Math.max(1, c.count - 1),
  );
  // Visual span is bounded by the count-based compact bound plus one marker height.
  expect(c.span).toBeLessThanOrEqual(compactBound + 3);
  // Every tick center (not the raw mark box edge) stays within the usable band.
  for (const center of c.centers) {
    expect(center).toBeGreaterThanOrEqual(PROMPT_MAP_RAIL_INSET - 0.5);
    expect(center).toBeLessThanOrEqual(c.railHeight - PROMPT_MAP_RAIL_INSET + 0.5);
  }
  // The cluster center is vertically aligned with the rail center (within one pitch).
  expect(Math.abs(c.clusterCenter - c.railHeight / 2)).toBeLessThanOrEqual(
    PROMPT_MAP_TICK_PITCH,
  );

  // Position/index association survives the paired projection: the contiguous mock
  // selection renders its ordered indices with strictly monotonic projected tops.
  const rendered = await map.getByTestId("prompt-map-tick").evaluateAll((els) =>
    els.map((el) => ({
      index: Number((el as HTMLElement).dataset.promptIndex),
      top: Number.parseFloat((el as HTMLElement).style.top),
    })),
  );
  expect(rendered.map((r) => r.index)).toEqual([0, 1]);
  expect(rendered[1]!.top).toBeGreaterThan(rendered[0]!.top);
});

test("clicking a map tick shares prompt navigation and highlights active turns", async ({ page }) => {
  await drive(page, "reply");
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 3);
  const map = page.getByTestId("prompt-map");
  await expect(map.getByTestId("prompt-map-tick")).toHaveCount(3);

  /** True when the scroller sits at prompt `idx`'s block-start target (same ≤4px
   *  check as polish.e2e.ts's atPrompt) — the map tick shares jumpToTarget's
   *  nav-settle path, so the landing must hold at the viewport top. */
  const atPrompt = (idx: number) =>
    page.evaluate((i) => {
      const sc = document.querySelector(".scroller") as HTMLElement | null;
      const row = document.querySelectorAll(".row.user")[i] as HTMLElement | undefined;
      if (!sc || !row) return false;
      const within =
        row.getBoundingClientRect().top -
        sc.getBoundingClientRect().top +
        sc.scrollTop;
      const max = sc.scrollHeight - sc.clientHeight;
      return Math.abs(sc.scrollTop - Math.min(within, max)) < 4;
    }, idx);

  const scroller = page.locator(".scroller");
  await scrollUpViaKeyboard(page);
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(0);
  await map.getByTestId("prompt-map-tick").nth(1).click();
  await expect(page.locator(".row.user.nav-flash")).toHaveCount(1);
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  // The clicked prompt's row must land (and hold) at the viewport top via the shared
  // jumpToTarget nav-settle path — not just flash and scroll.
  await expect.poll(() => atPrompt(1), { timeout: 10_000 }).toBe(true);

  // The map owns navigation for multi-prompt transcripts: no floating arrows, and a
  // second map-tick jump targets the newest prompt through the same shared path.
  await expect(page.getByTestId("prompt-nav-up")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-down")).toHaveCount(0);
  await map.getByTestId("prompt-map-tick").last().click();
  await expect(page.locator(".row.user").nth(2)).toHaveClass(/nav-flash/);
  await expect.poll(() => atPrompt(2), { timeout: 10_000 }).toBe(true);
});

test("long response keeps its prompt interval active after the prompt leaves the viewport", async ({ page }) => {
  await drive(page, "promptmaplong");
  await expect(page.getByText(/Paragraph 26:/)).toBeVisible();
  await drive(page, "reply");
  await expect(page.getByText("Show me the streamed reply script.").last()).toBeVisible();
  const scroller = page.locator(".scroller");
  const longPrompt = page.locator('.transcript-turn[data-prompt-id="u-promptmap-long"]');
  await scroller.evaluate((node) => node.scrollTo({ top: Math.max(0, node.scrollHeight / 2) }));
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() =>
    longPrompt.evaluate((node) => {
      const row = node.getBoundingClientRect();
      const viewport = (node.closest(".scroller") as HTMLElement).getBoundingClientRect();
      return row.top < viewport.top && row.bottom > viewport.top;
    }),
  ).toBe(true);
  await expect(page.getByTestId("prompt-map").getByRole("button", { name: /Show a long response so the prompt map/ })).toHaveClass(/active/);
});

test("prompt map exposes fallback previews for in-progress and tool-only turns", async ({ page }) => {
  await drive(page, "promptmaphold");
  await expect(page.getByText("Pause this prompt while the response is still in progress.")).toBeVisible();
  const map = page.getByTestId("prompt-map");
  await expect(map).toBeVisible();
  const holdTick = map.getByRole("button", { name: /Pause this prompt while the response/ });
  await holdTick.focus();
  await expect(page.getByTestId("prompt-map-preview")).toContainText("Response in progress");

  await drive(page, "promptmaptoolonly");
  await expect(page.getByText("Run a tool without producing a final response.")).toBeVisible();
  const toolTick = map.getByRole("button", { name: /Run a tool without producing/ });
  await toolTick.focus();
  await expect(page.getByTestId("prompt-map-preview")).toContainText("No final response");
});

test("the prompt map owns navigation for every prompt count", async ({ page }) => {
  // Post-bootstrap empty transcript: reset without bootstrap and clear the persisted
  // last-session preference so nothing restores, then land on the stable chooser.
  await page.request.get("/debug/reset?bootstrap=0");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("pantoken.lastSession.")) localStorage.removeItem(key);
    }
  });
  await page.reload();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-seed-ready", "true");
  await expect(page.getByTestId("session-chooser")).toBeVisible();
  await expect(page.locator(".row.user")).toHaveCount(0);
  await expect(page.getByTestId("prompt-map")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-up")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-down")).toHaveCount(0);

  // Fresh one-prompt state (greeting): no map, no arrows — nothing to navigate to.
  await gotoFresh(page);
  await expect(page.getByTestId("prompt-map")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-up")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-down")).toHaveCount(0);

  // Two prompts: the map appears and owns navigation; arrows stay absent.
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 2);
  await expect(page.getByTestId("prompt-map")).toBeVisible();
  await expect(page.getByTestId("prompt-nav-up")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-down")).toHaveCount(0);

  // Hovering the transcript must not resurrect a fallback arrow control.
  await page.locator(".transcript-wrap").hover();
  await expect(page.getByTestId("prompt-nav-up")).toHaveCount(0);
  await expect(page.getByTestId("prompt-nav-down")).toHaveCount(0);
});

test("hovering/focusing an active tick emphasizes its marker over the active/primary state", async ({ page }) => {
  await drive(page, "reply");
  await waitForSettledWorkBlocks(page, 2);
  const map = page.getByTestId("prompt-map");
  await expect(map).toBeVisible();
  const lastTick = map.getByTestId("prompt-map-tick").last();
  // At the live tail the last tick is the active marker (and often primary too).
  await expect(lastTick).toHaveClass(/active/);

  const readMark = () =>
    lastTick.locator(".tick-mark").evaluate((el) => {
      const style = getComputedStyle(el);
      return { width: style.width, backgroundColor: style.backgroundColor };
    });
  const baseline = await readMark();
  await lastTick.focus();
  await expect(lastTick).toHaveClass(/emphasized/);
  const highlighted = await readMark();
  // The highlight must visibly differ from the active/primary baseline (width and/or
  // color), proving the emphasis rule wins over the later-state rules.
  expect(
    highlighted.width !== baseline.width ||
      highlighted.backgroundColor !== baseline.backgroundColor,
  ).toBe(true);
  // Keyboard focus keeps the preview behavior for the focused tick.
  await expect(page.getByTestId("prompt-map-preview")).toContainText("That confirms it");
});
