import { expect, test, type Page } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

async function gateInitialWebSocket(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    let allow = false;
    let attempts = 0;

    class BlockedSocket {
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      extensions = "";
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      protocol = "";
      readyState: 0 | 1 | 2 | 3 = NativeWebSocket.CONNECTING;
      url = "ws://pantoken-blocked";

      constructor() {
        window.setTimeout(() => {
          this.readyState = NativeWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close"));
        }, 0);
      }

      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
      close() {
        this.readyState = NativeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
      send() {}
    }

    function GatedWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      attempts += 1;
      if (!allow) return new BlockedSocket() as unknown as WebSocket;
      return protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
    }

    GatedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    GatedWebSocket.OPEN = NativeWebSocket.OPEN;
    GatedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    GatedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    GatedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = GatedWebSocket as unknown as typeof WebSocket;

    Object.assign(window, {
      __pantokenAllowWebSocket: () => {
        allow = true;
      },
      __pantokenWebSocketAttempts: () => attempts,
    });
  });
}

async function gotoWithBlockedWebSocket(page: Page) {
  await page.request.get("/debug/reset");
  await gateInitialWebSocket(page);
  await page.goto("/?dev");
  const reconnect = page.getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible();
  return reconnect;
}

// --- Reload and reconnect survival (normal boot) ---

test.describe("reload and reconnect survival (normal boot)", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
  });

  // Reload preserves session state: first the streaming transcript, then a pending approval.
  test("session state survives a reload (transcript then pending approval)", async ({
    page,
  }) => {
    // Transcript: drive a reply, confirm it renders, reload, confirm it survived.
    await drive(page, "reply");
    await expect(
      page.getByText("Show me the streamed reply script."),
    ).toBeVisible();
    await page.goto("/?dev");
    await expect(
      page.getByText("Show me the streamed reply script."),
    ).toBeVisible();

    // Pending approval: drive a confirm, confirm the dialog renders, reload, confirm it survived.
    await drive(page, "confirm");
    await expect(
      page.getByRole("dialog").getByText("Run destructive command?"),
    ).toBeVisible();

    // reload WITHOUT resetting the server — a fresh client should catch up
    await page.reload();
    await page.goto("/?dev");

    await expect(
      page.getByRole("dialog").getByText("Run destructive command?"),
    ).toBeVisible();
  });

  // A dropped socket (a Tailscale flap on a phone) reconnects as a brand-new connection, which
  // the hub registers focused on the empty landing. The client must re-assert the session it
  // was reading, or the view snaps to a blank/landing pane mid-session. The mock's landing is
  // the greeting, distinct from the session we open here, so the bug reproduces deterministically.
  test("a reconnect keeps you on the session you were viewing", async ({
    page,
  }) => {
    // Open a session other than the bootstrap landing (the greeting).
    await openSidebar(page);
    await page.getByRole("button", { name: /^Explore the fold reducer/ }).click();
    await expect(
      page.getByText("It folds each driver event", { exact: false }),
    ).toBeVisible();

    // Drop the live socket and reconnect — the hub re-snapshots us onto the landing.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("pantoken:test-disconnect")),
    );
    const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
    await expect(reconnect).toBeVisible();
    await reconnect.click();

    // Re-asserted onto the same session — not snapped to the greeting landing.
    await expect(
      page.getByText("It folds each driver event", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Routes live in", { exact: false })).toHaveCount(
      0,
    );
  });
});

// --- Reconnect (special boot) ---
// No beforeEach — each test installs its own boot setup before navigation.

// The connection banner offers an immediate reconnect from a blocked initial WebSocket.
test("the connection banner can reconnect immediately", async ({ page }) => {
  const reconnect = await gotoWithBlockedWebSocket(page);
  await expect(reconnect).toHaveAttribute("title", "Reconnect now (Alt+R)");
  const before = await page.evaluate(() =>
    (window as any).__pantokenWebSocketAttempts(),
  );

  await page.evaluate(() => (window as any).__pantokenAllowWebSocket());
  await reconnect.click();

  await expect(
    page.getByText("Routes live in", { exact: false }),
  ).toBeVisible();
  await expect(reconnect).toBeHidden();
  const after = await page.evaluate(() =>
    (window as any).__pantokenWebSocketAttempts(),
  );
  expect(after).toBeGreaterThan(before);
});

// Protocol v2 resume: a reconnect mid-stream must not duplicate transcript
// content — AND must actually resume. The reconnect hello carries the fold
// watermark {epoch, seq}; the server tail-replays only the missed frames. The
// recorded wire frames prove resume engaged: after the reconnect's hello there
// are live events but NO seed (a silent regression to full re-seeding — the
// exact cost resume exists to kill — fails the frame assertion below).
test("a mid-stream reconnect resumes (no re-seed) without duplicated bubbles", async ({
  page,
}) => {
  // Record server→client frame types on every socket. Must be installed BEFORE
  // navigation: routeWebSocket patches the page's WebSocket at document init,
  // so a mid-life install would silently miss the reconnect's socket.
  const frameTypes: string[] = [];
  await page.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        frameTypes.push(JSON.parse(String(message)).type as string);
      } catch {
        frameTypes.push("?");
      }
      ws.send(message as string);
    });
    ws.onMessage((message) => server.send(message as string));
  });
  await gotoFresh(page);

  await drive(page, "reply");
  // The turn is visibly under way…
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  await expect(page.getByText("Good question.")).toBeVisible();

  // …cut the transport mid-stream. The mock keeps emitting server-side.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  await expect(
    page.getByText("Offline — the agent keeps running"),
  ).toBeVisible();

  // Reconnect. The hello carries {epoch, seq}; the server fills the gap.
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText("Offline — the agent keeps running")).toHaveCount(
    0,
  );

  // The completed reply is present exactly once — nothing doubled by the
  // reconnect, no half-applied transcript. (The mid-turn "Good question…" text
  // collapses into the settled work block, so assert on what stays rendered:
  // the prompt row and the turn-final reply.)
  await expect(
    page.getByText("That confirms it. Making the change now"),
  ).toHaveCount(1);
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toHaveCount(1);

  // Resume engaged: a second hello was recorded (the reconnect), and nothing
  // after it is a seed — the transcript survived on the client and only the
  // gap was tail-replayed.
  const lastHello = frameTypes.lastIndexOf("hello");
  expect(lastHello).toBeGreaterThan(frameTypes.indexOf("hello"));
  expect(frameTypes.slice(lastHello)).not.toContain("seed");
});
