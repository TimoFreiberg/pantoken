import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// --- Session lifecycle (normal boot) ---

test.describe("session lifecycle (normal boot)", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
  });

  // When opening a session that the TUI holds (a 409 lease conflict), the operator
  // gets a sticky toast with a "Retry" action. Tapping Retry re-sends the
  // openSession; the mock's one-shot failure clears on the second attempt, so the
  // session opens. Non-lease session-switch errors keep the 8s auto-dismiss toast
  // (no Retry button — they aren't blindly retryable).
  test("a lease conflict surfaces a sticky Retry toast; retrying opens the session", async ({
    page,
  }) => {
    await openSidebar(page);
    const sidebar = page.getByTestId("sidebar");

    // Arm the one-shot 409 failure for the NEXT openSession (switching to a
    // different session triggers it).
    await drive(page, "failsession");

    // Switch to a different session — the first attempt throws the 409.
    await sidebar.getByText("Explore the fold reducer").click();

    // The toast appears with the lease-conflict message.
    const toast = page
      .getByTestId("chat-notice")
      .getByTestId("toast")
      .filter({ hasText: "another TUI is attached" });
    await expect(toast).toBeVisible();

    // The Retry action button is present (sticky — no auto-dismiss).
    await expect(
      toast.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();

    // The toast is sticky: it persists past the 8s auto-dismiss window (the operator
    // may be detaching in the TUI). Use a generous poll + a short wait to prove it.
    await page.waitForTimeout(2000);
    await expect(toast).toBeVisible();

    // Click Retry → the second openSession succeeds (the one-shot flag cleared).
    await toast.getByRole("button", { name: "Retry", exact: true }).click();

    // The session opens — its greeting text appears, proving the retry landed.
    await expect(
      page.getByText("How does foldEvent assemble the transcript?"),
    ).toBeVisible();

    // The toast dismissed on the Retry click (the action runs dismissToast).
    await expect(toast).toHaveCount(0);
  });

  // Regression: mid-turn, the context meter used to freeze at its last turn-boundary
  // value. The only events that fire between a turn's start and its runCompleted are
  // deltas/tool/user — none carries fresh `usage` — so a long-running session showed a
  // stale meter. The hub now re-pushes usage on a debounced ticker while a turn runs.
  // (The companion guard — that the ticker also re-broadcasts the session LIST mid-turn —
  // lives in hub.test.ts "the live ticker refreshes the session list + focused usage
  // mid-turn"; the sidebar no longer renders a per-row message count to assert on here.)
  test("the context meter climbs live while a turn runs", async ({ page }) => {
    const meter = page.getByTestId("context-trigger");
    await expect(meter).toHaveAttribute("aria-label", /24% used/); // MOCK_USAGE baseline: 47,200 / 200,000

    await drive(page, "streamhold"); // a turn that goes running and stays running
    // The ticker polls the (growing) mock usage every PANTOKEN_LIVE_REFRESH_MS, so the meter
    // climbs past its frozen baseline without waiting for the turn to end.
    await expect(meter).toHaveAttribute("aria-label", /(?:2[5-9]|[3-9]\d)% used/);
  });

  // The sidebar session right-click menu shows a "Detach session" item with a D hotkey
  // badge and a tooltip explaining its purpose. The mock driver's detach_session is a
  // no-op (trait default → Ok(())), so clicking it must not produce a toast or error.
  test("the detach session menu item shows with a D hotkey and is a no-op on the mock", async ({
    page,
  }) => {
    await openSidebar(page);
    const sidebar = page.getByTestId("sidebar");
    const row = sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Explore the fold reducer" });
    await row.hover();
    await row.getByTestId("session-menu").click();

    const item = sidebar.getByTestId("detach-session");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Detach session");
    await expect(item.locator("kbd.hotkey")).toHaveText("D");
    await expect(item).toHaveAttribute(
      "title",
      /Release Pantoken's attachment lease/,
    );

    // Clicking detach is a no-op on the mock (returns Ok).
    await sidebar.getByTestId("detach-session").click();

    // No toast appears (the mock's detach is a no-op that returns Ok).
    await expect(page.getByTestId("toast")).toHaveCount(0);
    // The menu closes after clicking.
    await expect(sidebar.getByTestId("detach-session")).toHaveCount(0);
  });

  // A background approval stays obvious in the sidebar (waiting status + attention
  // indicator) and opens the right session when clicked.
  test("a background approval stays obvious and opens the right session", async ({
    page,
  }) => {
    const BG = "Explore the fold reducer";

    await openSidebar(page);
    await drive(page, "bgwait");

    const sidebar = page.getByTestId("sidebar");
    const row = sidebar.locator(".row", { hasText: BG });
    const status = row.getByTestId("session-status");
    await expect(status).toHaveAttribute("data-state", "waiting");
    // The row's hover tooltip was removed (it duplicated visible text). The
    // status span at the row's right edge carries the attention detail instead.
    await expect(status).toHaveAttribute("title", /Review background change/);

    const project = sidebar.locator(".group", { hasText: "pantoken" });
    await project.locator(".group-toggle").click();
    await expect(project.locator(".group-attention")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    await project.locator(".group-toggle").click();

    await row.click();
    await expect(
      page.getByRole("heading", { name: "Review background change" }),
    ).toBeVisible();
    await expect(
      page.getByText("Apply the queued background edit?"),
    ).toBeVisible();
  });

  // The transition from the chooser to a new transcript must never expose the
  // previously focused session. The warm-up placeholder (creatingSession) carries
  // the gap until the new session's snapshot lands.
  test("a new session created via the chooser never flashes the previously focused transcript", async ({
    page,
  }) => {
    // The greeting (demo) session is focused on load — its prompt is in the transcript.
    const oldPrompt = page.getByText("Add a /health route to the server");
    await expect(oldPrompt).toBeVisible();

    // Open the chooser and create a session (prompt-less create-on-click).
    await openSidebar(page);
    await page.getByTestId("sidebar").getByTestId("sidebar-new-session").getByText("New session").click();
    await expect(page.getByTestId("session-chooser")).toBeVisible();

    // The pre-selected project (pantoken) — Enter creates a session immediately.
    await page.getByLabel("Filter projects").press("Enter");

    // The chooser is gone. The warm-up indicator may flash briefly, but the mock
    // seeds fast — the critical invariant is that the old session's content never
    // appears during the transition.
    await expect(page.getByTestId("session-chooser")).toHaveCount(0);
    // No stop button during warm-up — there's no turn to abort yet.
    await expect(page.getByTestId("stop-button")).toHaveCount(0);
    // The old session's content never appears during warm-up or after seeding.
    await expect(oldPrompt).toHaveCount(0);

    // The live-session composer mounts once the seed lands.
    const composer = page.getByPlaceholder("Message pantoken…");
    await composer.fill("kick off the brand new session please");
    await composer.press("Enter");

    // The just-sent prompt is the FIRST (and only) transcript bubble — the old session's
    // content is gone, never showing the new prompt appended below a stale transcript.
    const firstBubble = page.locator(".row.user .bubble").first();
    await expect(firstBubble).toHaveText("kick off the brand new session please");
    await expect(oldPrompt).toHaveCount(0);

    // The new session's OWN reply streams into ITS transcript (not the demo session's), and
    // the optimistic prompt row has handed off to the authoritative one without duplicating.
    await expect(page.getByText("On it — the session's up")).toBeVisible();
    await expect(
      page.locator(".row.user .bubble", {
        hasText: "kick off the brand new session please",
      }),
    ).toHaveCount(1);
    await expect(oldPrompt).toHaveCount(0);
  });

  // When creating a new session fails (e.g. the real driver's daemon spawn
  // hits an error), the warm-up placeholder must NOT leave the user stuck on a
  // "Starting session…" view. The error handler clears `creatingSession` and
  // reopens the chooser so the user can retry or pick a different project.
  // `drive(page, "failnewsession")` arms a one-shot mock newSession() rejection.
  test("a failed create-on-click clears the warm-up placeholder and returns to the chooser", async ({
    page,
  }) => {
    // Open the chooser.
    await openSidebar(page);
    await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
    await expect(page.getByTestId("session-chooser")).toBeVisible();

    // Arm the one-shot creation failure BEFORE selecting a project (the mock
    // rejects the next newSession() call).
    await drive(page, "failnewsession");

    // Select a project — createSession fires immediately, the mock fails.
    await page
      .getByTestId("session-chooser")
      .locator(".result.project")
      .first()
      .click();

    // The warm-up indicator must NOT be stuck — creatingSession is cleared.
    await expect(page.getByTestId("working-indicator")).toHaveCount(0);

    // The chooser reappears so the user can retry.
    await expect(page.getByTestId("session-chooser")).toBeVisible();

    // The error is surfaced (lastError renders in the sidebar as an alert).
    await expect(page.getByRole("alert")).toContainText(
      "Could not create the new session",
    );
  });
});

// --- Multi-client, protocol, and deep-link (special boot) ---
// No beforeEach — each test sets up its own boot.

// Per-client session focus: each browser picks which session it's viewing
// independently, so switching on one device must not switch the transcript out from
// under another. Two isolated browser contexts share one mock server (two WS
// connections = two independent focus states).
test("switching session on one client doesn't move another", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    // Fresh shared server state, then connect both clients (no stored last-session, so
    // each adopts the bootstrap landing greeting).
    await a.request.get("/debug/reset");
    await a.goto("/");
    await b.goto("/");

    // Both land on the greeting session.
    for (const page of [a, b])
      await expect(page.locator("header .title")).toContainText(
        "Wire up the WebSocket bridge",
      );

    // Client A switches to a different session.
    await openSidebar(a);
    await a
      .getByTestId("sidebar")
      .getByText("Explore the fold reducer")
      .click();
    await expect(
      a.getByText("How does foldEvent assemble the transcript?"),
    ).toBeVisible();
    await expect(a.locator("header .title")).toContainText(
      "Explore the fold reducer",
    );

    // Client B is untouched: still on the greeting, never shown A's session.
    await expect(b.locator("header .title")).toContainText(
      "Wire up the WebSocket bridge",
    );
    await expect(
      b.getByText("How does foldEvent assemble the transcript?"),
    ).toHaveCount(0);

    // And B can still drive its own focus independently afterwards.
    await b.goto("/?dev");
    await expect(b.locator("header .title")).toContainText(
      "Wire up the WebSocket bridge",
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// Two browser pages = two WS clients on the same server session. Verifies the
// server-authoritative broadcast: a dialog raised for the session shows on both,
// and resolving it on one settles it on the other.
test("a dialog broadcasts to both clients and resolves on both", async ({
  context,
  page,
}) => {
  await page.request.get("/debug/reset");

  const p1 = page;
  const p2 = await context.newPage();
  await p1.goto("/?dev");
  await p2.goto("/?dev");
  await expect(p1.getByText("Routes live in")).toBeVisible();
  await expect(p2.getByText("Routes live in")).toBeVisible();

  await p1.getByRole("button", { name: "confirm", exact: true }).click();

  // both clients see the same dialog (broadcast)
  await expect(
    p1.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();
  await expect(
    p2.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();

  // answering on p1 settles it everywhere
  await p1.getByRole("dialog").getByRole("button", { name: "Allow" }).click();
  await expect(p1.getByRole("dialog")).toBeHidden();
  await expect(p2.getByRole("dialog")).toBeHidden();
  await expect(p2.getByText("Approved — continuing.")).toHaveCount(1);

  // The client that DIDN'T answer (p2) gets a "resolved elsewhere" notice instead of the
  // sheet silently vanishing; the answering client (p1) does not.
  await expect(p2.getByText("Resolved on another device")).toBeVisible();
  await expect(p1.getByText("Resolved on another device")).toHaveCount(0);

  await p2.close();
});

// Protocol v2's safety net: the client hard-fails on a hello whose
// protocolVersion doesn't match its own bundled constant, instead of silently
// misfolding a newer server's stream (the stale-cached-PWA case). Simulate the
// skew by tampering the hello frame in flight; everything else is forwarded
// untouched, so this exercises the real client check end to end.
test("a protocol-version skew shows the update-required screen", async ({
  page,
}) => {
  await page.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        const parsed = JSON.parse(String(message));
        if (parsed.type === "hello") {
          parsed.protocolVersion = 0;
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch {
        // non-JSON frame — forward untouched
      }
      ws.send(message as string);
    });
    ws.onMessage((message) => server.send(message as string));
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Update required" }),
  ).toBeVisible();
  await expect(page.getByText(/doesn't match client/)).toBeVisible();
});

// A notification deep link (/?session=<id>) focuses its target session on load,
// then the URL normalizes (drops the query param) once the session is focused.
test("a notification deep link focuses its target session", async ({ page }) => {
  await page.request.get("/debug/reset");
  await page.goto("/?session=older-session");
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/session=/);
});
