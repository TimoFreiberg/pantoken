import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

type NavigationRecord = {
  sequence: number;
  timestamp: number;
  url: string;
  initialNavigation: boolean;
  type:
    | "frame-navigated"
    | "load"
    | "requestfailed"
    | "pageerror"
    | "console";
  status?: number;
  failure?: string;
  message?: string;
  readyState?: string;
  navigationType?: string;
  serviceWorkerController?: boolean;
  serviceWorkerRegistrations?: number;
  protocolMismatch?: string | null;
  appUpdateReady?: boolean;
};

type NavigationObserver = {
  records: NavigationRecord[];
  frameNavigationCount: number;
  stop: () => Promise<void>;
  snapshot: () => string;
};

function installNavigationObserver(page: Page): NavigationObserver {
  const records: NavigationRecord[] = [];
  const requestStatuses = new Map<string, number>();
  let sequence = 0;
  let frameNavigationCount = 0;
  let mainFrameNavigationSeen = false;
  let stopped = false;

  const push = (
    record: Omit<NavigationRecord, "sequence" | "timestamp" | "initialNavigation">,
  ): NavigationRecord | undefined => {
    if (stopped) return undefined;
    const initialNavigation =
      record.type === "frame-navigated" && !mainFrameNavigationSeen;
    if (initialNavigation) mainFrameNavigationSeen = true;
    const completeRecord: NavigationRecord = {
      sequence: ++sequence,
      timestamp: Date.now(),
      initialNavigation,
      ...record,
    };
    records.push(completeRecord);
    return completeRecord;
  };

  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      requestStatuses.set(request.url(), 0);
    }
  };
  const onResponse = (response: import("@playwright/test").Response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      requestStatuses.set(request.url(), response.status());
    }
  };
  const onRequestFailed = (request: import("@playwright/test").Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      push({
        type: "requestfailed",
        url: request.url(),
        failure: request.failure()?.errorText,
        status: requestStatuses.get(request.url()),
      });
    }
  };
  const pendingDiagnostics = new Set<Promise<void>>();
  const trackDiagnostics = (
    type: "frame-navigated" | "load",
    url: string,
    status: number | undefined,
  ) => {
    const record = push({ type, url, status });
    if (!record) return;
    const pending = readPageDiagnostics(page).then((details) => {
      Object.assign(record, details);
    });
    pendingDiagnostics.add(pending);
    void pending.finally(() => pendingDiagnostics.delete(pending));
  };
  const onFrameNavigated = (frame: import("@playwright/test").Frame) => {
    if (frame !== page.mainFrame()) return;
    frameNavigationCount += 1;
    trackDiagnostics("frame-navigated", frame.url(), requestStatuses.get(frame.url()));
  };
  const onLoad = () => {
    trackDiagnostics("load", page.url(), requestStatuses.get(page.url()));
  };
  const onPageError = (error: Error) => {
    push({
      type: "pageerror",
      url: page.url(),
      message: error.stack ?? error.message,
    });
  };
  const onConsole = (message: import("@playwright/test").ConsoleMessage) => {
    if (message.type() === "error" || message.type() === "warning") {
      push({
        type: "console",
        url: page.url(),
        message: `${message.type()}: ${message.text()}`,
      });
    }
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("framenavigated", onFrameNavigated);
  page.on("load", onLoad);
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  const observer: NavigationObserver = {
    records,
    get frameNavigationCount() {
      return frameNavigationCount;
    },
    stop: async () => {
      stopped = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      page.off("framenavigated", onFrameNavigated);
      page.off("load", onLoad);
      page.off("pageerror", onPageError);
      page.off("console", onConsole);
      await Promise.allSettled(pendingDiagnostics);
    },
    snapshot: () => JSON.stringify(records),
  };
  return observer;
}

async function readPageDiagnostics(page: Page): Promise<
  Omit<NavigationRecord, "sequence" | "timestamp" | "type" | "url" | "initialNavigation">
> {
  try {
    return await page.evaluate(async () => ({
      readyState: document.readyState,
      navigationType: (
        performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
      )?.type,
      serviceWorkerController: Boolean(navigator.serviceWorker?.controller),
      serviceWorkerRegistrations: "serviceWorker" in navigator
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
      protocolMismatch: document.querySelector(".fatal")?.textContent?.trim() ?? null,
      appUpdateReady: Boolean(document.querySelector(".update-toast")),
    }));
  } catch {
    return {};
  }
}

/** Read the current bottom gap (scrollHeight - scrollTop - clientHeight). */
function gapFn(scroller: import("@playwright/test").Locator) {
  return scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight -
      (el as HTMLElement).scrollTop -
      (el as HTMLElement).clientHeight,
  );
}

/** Assert the scroller is pinned at the live bottom (gap ≈ 0) and the final
 *  assistant row is entirely above the composer (no clipping). */
async function assertPinnedToBottom(
  page: import("@playwright/test").Page,
): Promise<void> {
  const scroller = page.locator(".scroller");
  // Near-zero bottom gap — the ResizeObserver keeps us at the exact bottom.
  await expect.poll(() => gapFn(scroller), { timeout: 5000 }).toBeLessThan(4);
  // The final assistant row's bottom edge is above the composer's top edge.
  const clearance = await page.evaluate(() => {
    const rows = document.querySelectorAll(".row.assistant");
    const lastRow = rows[rows.length - 1];
    const composer = document.querySelector(".composer-wrap");
    if (!lastRow || !composer) return -1;
    return (
      composer.getBoundingClientRect().top -
      lastRow.getBoundingClientRect().bottom
    );
  });
  expect(clearance).toBeGreaterThan(0);
}

/** Wait for the settle window to lapse, then insert a small spacer BEFORE the final
 *  assistant row — mimicking a late image decode in a row above the final text that
 *  grows the content height and pushes the final row down. Appending at the END would
 *  grow scrollHeight (opening a gap) but wouldn't move the final row, so the
 *  clearance check wouldn't be discriminative. Inserting before the final row pushes
 *  it down, matching the real bug: images decode in rows ABOVE the final assistant
 *  text, pushing it below the viewport. (overflow-anchor: none is set globally on
 *  .scroller via CSS — #86, no per-test override needed.) */
async function forceLateHeightChange(
  page: import("@playwright/test").Page,
  px: number,
): Promise<void> {
  const scroller = page.locator(".scroller");
  // Wait for the 500ms settle window to lapse (plus margin).
  await page.waitForTimeout(1500);
  await scroller.locator(".col").evaluate((el, height) => {
    const rows = el.querySelectorAll(".row.assistant");
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return;
    const spacer = document.createElement("div");
    spacer.id = "test-late-decode";
    spacer.style.height = `${height}px`;
    lastRow.parentNode!.insertBefore(spacer, lastRow);
  }, px);
}

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=";

async function dispatchFiles(
  page: Page,
  kind: "paste" | "dragenter" | "drop",
  files: { name: string; type: string; base64: string }[],
): Promise<void> {
  await page.evaluate(
    ({ kind, files }) => {
      const transfer = new DataTransfer();
      for (const item of files) {
        const bytes = Uint8Array.from(atob(item.base64), (char) =>
          char.charCodeAt(0),
        );
        transfer.items.add(new File([bytes], item.name, { type: item.type }));
      }
      if (kind === "paste") {
        document.querySelector("textarea")?.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        document.querySelector(".composer-wrap")?.dispatchEvent(
          new DragEvent(kind, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    { kind, files },
  );
}

test.beforeEach(async ({ page }) => {
  // Phase 1 lifecycle observation starts before gotoFresh so the initial document
  // navigation is distinguishable from any late reload before synthetic paste.
  const observer = installNavigationObserver(page);
  try {
    await gotoFresh(page);
  } catch (error) {
    throw new Error(
      `Fresh image boot failed; diagnostics=${observer.snapshot()}: ${String(error)}`,
      { cause: error },
    );
  } finally {
    await observer.stop();
  }
});

// Flow: paste a screenshot, send it image-only, and confirm the outbox proxy-leak
// regression banner stays absent.
test("paste + send: a pasted screenshot attaches, image-only send works, and no prompt-outbox banner appears", async ({
  page,
}) => {
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-seed-ready", "true");
  await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => ({
        controller: Boolean(navigator.serviceWorker?.controller),
        registrations: "serviceWorker" in navigator
          ? (await navigator.serviceWorker.getRegistrations()).length
          : 0,
      })),
    )
    .toEqual({ controller: false, registrations: 0 });

  const observer = installNavigationObserver(page);
  const beforeDispatch = observer.frameNavigationCount;
  let dispatchError: unknown;
  try {
    await dispatchFiles(page, "paste", [
      { name: "screenshot.png", type: "image/png", base64: PNG },
    ]);
  } catch (error) {
    dispatchError = error;
  } finally {
    await observer.stop();
  }
  const dispatchNavigations = observer.frameNavigationCount - beforeDispatch;
  if (dispatchError !== undefined) {
    throw new Error(
      `Synthetic paste failed after ${dispatchNavigations} frame navigation(s); ` +
        `diagnostics=${observer.snapshot()}: ${String(dispatchError)}`,
      { cause: dispatchError },
    );
  }
  expect(
    dispatchNavigations,
    `Synthetic paste dispatch navigated the document; diagnostics=${observer.snapshot()}`,
  ).toBe(0);

  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("sent-image")).toBeVisible();
  // Regression: the outbox persists each prompt to IndexedDB, which refuses to clone
  // Svelte `$state` proxies. Image-bearing prompts must reach the outbox as plain data;
  // a proxy leak surfaces a "couldn't update the prompt outbox" banner here (delivery
  // still happens, so the image above shows up either way — assert the banner is absent).
  await expect(page.getByText("prompt outbox")).toHaveCount(0);
});

// Flow: paste two images, open the lightbox to walk the batch and dismiss it, then
// remove one attachment via its × badge without sending.
test("thumbnail chips: paste two images, preview the batch in the lightbox, then remove one via the × badge", async ({
  page,
}) => {
  await dispatchFiles(page, "paste", [
    { name: "a.png", type: "image/png", base64: PNG },
    { name: "b.png", type: "image/png", base64: PNG },
  ]);
  await expect(page.locator(".thumb-chip img")).toHaveCount(2);

  // Click a thumbnail's image (not its × badge) to enlarge it.
  await page.locator(".thumb-chip").first().locator(".thumb-preview").click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".counter")).toHaveText("1 / 2");

  // → / next button advances; the counter follows.
  await lightbox.getByRole("button", { name: "Next image" }).click();
  await expect(lightbox.locator(".counter")).toHaveText("2 / 2");

  // Escape dismisses and returns focus to the composer.
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(page.locator("textarea")).toBeFocused();

  // The × badge removes a single attachment without sending. (Both images are still
  // attached from the paste above; re-assert the count before removing to mirror the
  // original separate test's post-dispatch assertion.)
  await expect(page.locator(".thumb-chip img")).toHaveCount(2);
  await page
    .locator(".thumb-chip")
    .first()
    .getByRole("button", { name: /Remove attachment/ })
    .click();
  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  // Removing an attachment must not open the preview.
  await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
});

// Flow: drag/drop shows a target overlay and visibly rejects unsupported files, then
// accepts a supported image drop.
test("drag/drop: shows a target overlay, rejects unsupported files, and accepts a supported image", async ({
  page,
}) => {
  const text = btoa("not an image");
  await dispatchFiles(page, "dragenter", [
    { name: "notes.txt", type: "text/plain", base64: text },
  ]);
  await expect(page.getByTestId("image-drop-overlay")).toBeVisible();
  await dispatchFiles(page, "drop", [
    { name: "notes.txt", type: "text/plain", base64: text },
  ]);
  await expect(page.getByTestId("image-drop-overlay")).toHaveCount(0);
  await expect(page.getByTestId("attachment-status")).toContainText(
    "unsupported image type",
  );

  await dispatchFiles(page, "drop", [
    { name: "drop.png", type: "image/png", base64: PNG },
  ]);
  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  await expect(page.getByTestId("attachment-status")).toHaveCount(0);
});

// Flow: the attachment count limit is enforced before reading extra files.
test("attachment limit: pasting more than 10 images caps at 10 and reports the limit", async ({
  page,
}) => {
  await dispatchFiles(
    page,
    "paste",
    Array.from({ length: 11 }, (_, index) => ({
      name: `${index}.png`,
      type: "image/png",
      base64: PNG,
    })),
  );

  await expect(page.locator(".thumb-chip img")).toHaveCount(10);
  await expect(page.getByTestId("attachment-status")).toContainText(
    "Only 10 images",
  );
});

// Flow: an oversized camera-style image is compressed before attachment.
test("compression: an oversized camera-style image is compressed before attachment", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1800;
    canvas.height = 1800;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 0x12345678;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("encode failed")),
        "image/jpeg",
        1,
      ),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "camera.jpg", { type: "image/jpeg" }));
    document.querySelector("textarea")?.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(page.locator(".thumb-chip img")).toHaveCount(1);
  await expect(page.getByTestId("attachment-status")).toContainText(
    "Compressed 1 oversized image",
  );
});

/** The image-output ToolCard for the settled image turn. The screenshot/mockup is now
 *  surfaced in the turn's always-visible slot (no work-block drill, no summary card), so
 *  we find the card by the <img> it renders unconditionally outside its collapsible body. */
function imageToolCard(page: Page) {
  return page.locator(".tool").filter({ has: page.locator("img.out-img") });
}

// Journey: repeated image fixture turns preserve attachment echo, tool output, and
// viewer behavior. Locators are scoped to the latest matching item after each drive.
test("image rendering and viewer behaviors across successive turns", async ({ page }) => {
  await drive(page, "images");
  await expect(page.getByText("can you mock up a cleaner layout?")).toBeVisible();
  let att = page.locator("img.att-img").last();
  await expect(att).toBeVisible();
  await expect(att).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => att.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

  await drive(page, "images");
  const out = page.locator("img.out-img").last();
  await expect(out).toBeVisible();
  await expect(out).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => out.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  const card = imageToolCard(page).last();
  await card.locator(".head").click();
  await expect(card.getByText("Rendered mockup (160×100 PNG).")).toBeVisible();

  await drive(page, "images");
  att = page.locator("img.att-img").last();
  await expect(att).toBeVisible();
  await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
  await att.click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".stage img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
});

// Flow: both images (user attachment + tool output) survive a reload — the typed image
// data lives in the server's authoritative SessionState and re-ships on reconnect.
test("reload survival: both images survive a reload (typed images in the state snapshot)", async ({
  page,
}) => {
  await drive(page, "images");
  await expect(page.locator("img.out-img")).toBeVisible();
  // The image data lives in ToolItem.images / UserItem.images, which the server holds in
  // its authoritative SessionState and re-ships on reconnect. Reload WITHOUT resetting:
  // a fresh client must rebuild the same images.
  await page.goto("/?dev");
  await waitForSettledWorkBlocks(page, 1);

  // User attachment — always visible in the user row.
  const att = page.locator("img.att-img");
  await expect(att).toBeVisible();
  await expect
    .poll(() => att.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);

  // Tool output image — visible without any drill, even after a reload.
  const out = page.locator("img.out-img");
  await expect(out).toBeVisible();
  await expect
    .poll(() => out.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
});

// Flow: a pinned transcript stays at the live bottom as images decode and after a
// reload, even when a late height change mimics a slow image decode.
test("pin to bottom: transcript stays pinned at the live bottom as images decode and after reload", async ({
  page,
}) => {
  await drive(page, "images");
  await waitForSettledWorkBlocks(page, 1);

  // Wait for both images to actually decode (not just <img> with a src).
  const att = page.locator("img.att-img");
  const out = page.locator("img.out-img");
  await expect
    .poll(() => att.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  await expect
    .poll(() => out.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);

  // ── AC.1, AC.2: gap is near-zero and the final row is above the composer.
  await assertPinnedToBottom(page);

  // Precondition: the content must overflow the viewport for the gap check to be
  // discriminative. If the fixture doesn't produce enough content, the gap is
  // always ~0 regardless of the fix (nothing to scroll).
  const scroller = page.locator(".scroller");
  const scrollable = await scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight,
  );
  expect(scrollable).toBe(true);

  // Simulate a LATE image decode (the real failure surface): overflow-anchor is
  // disabled globally on .scroller via CSS (#86 — Chrome's auto-anchoring would
  // otherwise mask the bug), so let the settle window lapse, then force a small
  // height change that mimics a slow image decode. Without the fix, the
  // ResizeObserver is settle-window-gated and the drift
  // watcher's 200px threshold misses this gap; the final message is clipped.
  await forceLateHeightChange(page, 68);
  await assertPinnedToBottom(page);
  // AC.3: the "New messages ↓" pill never appeared. This is a non-discriminative
  // sanity check — with overflow-anchor off and a DOM-appended spacer, no scroll
  // event fires so `pinned` stays true regardless of the fix. The spurious-unread
  // symptom (which requires live streaming + a scroll event un-pinning) is
  // implicitly covered by AC.1: if the gap stays < 4px, `pinned` never flips and
  // `markActiveUnread` is never called. The pill assertion here guards against a
  // regression where the fix itself accidentally un-pins.
  await expect(page.getByTestId("new-messages-pill")).toHaveCount(0);

  // ── AC.2 (reload): after reload, the same invariant holds.
  await page.goto("/?dev");
  await waitForSettledWorkBlocks(page, 1);
  await expect
    .poll(() => page.locator("img.att-img").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.locator("img.out-img").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  await forceLateHeightChange(page, 68);
  await assertPinnedToBottom(page);
});
