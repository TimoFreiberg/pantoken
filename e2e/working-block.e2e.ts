import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the collapse affordance never appears while the final response is still streaming", async ({
  page,
}) => {
  await page.evaluate(() => {
    const probe = {
      sawLiveToggle: false,
      observer: null as MutationObserver | null,
    };
    const scan = () => {
      if (
        [...document.querySelectorAll('[data-testid="work-toggle"]')].some(
          (el) => el.textContent?.includes("Working…"),
        )
      ) {
        probe.sawLiveToggle = true;
      }
    };
    probe.observer = new MutationObserver(scan);
    probe.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    (
      window as Window & {
        __pantokenCollapseProbe?: typeof probe;
      }
    ).__pantokenCollapseProbe = probe;
    scan();
  });

  await drive(page, "reply");
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() => page.getByTestId("working-indicator").count())
    .toBe(0);

  const sawLiveToggle = await page.evaluate(() => {
    const probe = (
      window as Window & {
        __pantokenCollapseProbe?: {
          sawLiveToggle: boolean;
          observer: MutationObserver | null;
        };
      }
    ).__pantokenCollapseProbe;
    probe?.observer?.disconnect();
    return probe?.sawLiveToggle ?? false;
  });
  expect(sawLiveToggle).toBe(false);
  await expect(page.getByTestId("work-toggle")).toHaveCount(2);
});

test("each turn's working block collapses independently", async ({ page }) => {
  // Drive a second turn (the reply script) on top of the greeting. Both settle, so both
  // collapse — two independent "Worked for Ns" headers.
  await drive(page, "reply");
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();

  const toggles = page.getByTestId("work-toggle");
  await expect(toggles).toHaveCount(2);

  // Expanding the latest turn's block doesn't open the greeting's.
  await expandWork(page, "last");
  await expect(toggles.last()).toHaveAttribute("aria-expanded", "true");
  await expect(toggles.first()).toHaveAttribute("aria-expanded", "false");
  // The greeting's narration stays hidden; the reply's is revealed.
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toHaveCount(0);
  await expect(
    page.getByText("Here's the plan", { exact: false }),
  ).toBeVisible();
});
