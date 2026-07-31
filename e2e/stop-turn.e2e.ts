import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// A streaming turn shows the Stop pill + working indicator (no spinner), and the
// stop affordance shares the composer's left edge. Enter while streaming queues a
// follow-up and clears the box.
test("the Stop pill + working indicator show while a normal turn streams", async ({
  page,
}) => {
  await drive(page, "streamhold"); // goes running and stays running
  await expect(page.getByTestId("working-indicator")).toBeVisible();
  // AC.1: no spinner (orbiting dot/coin) renders — the stop button replaced it.
  await expect(
    page.getByTestId("working-indicator").locator(".coin, .dot, .ring, .mark"),
  ).toHaveCount(0);
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();

  // The stop affordance belongs to the same bottom chrome as the composer, so their
  // surfaces share one left edge rather than making the stop pill float in the gutter.
  const stopBox = await stop.boundingBox();
  const composerBox = await page.getByTestId("composer-surface").boundingBox();
  expect(stopBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(stopBox!.x).toBeCloseTo(composerBox!.x, 1);
  // Enter while streaming queues a follow-up (the driver routes mid-turn sends to
  // /turn/input). Enter clears the box (the message is queued) — guards the
  // composer-side behavior the removed toggle tests covered.
  const box = page.getByPlaceholder("Queue a message…");
  await box.fill("a queued nudge");
  await box.press("Enter");
  await expect(box).toHaveValue("");
});

// Dropping the socket mid-turn leaves the Stop pill visible but inert (disabled)
// with an explanatory tooltip — a remote turn can't be stopped.
test("the Stop pill disables while offline (a remote turn can't be stopped)", async ({
  page,
}) => {
  await drive(page, "streamhold"); // goes running and stays running
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeEnabled();

  // Drop the socket: the turn keeps running server-side, so the pill stays visible but
  // goes inert (a dead click would silently no-op) with an explanatory tooltip.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute(
    "title",
    "Can't stop while offline — the agent keeps running",
  );
});

// A slow abort delays the entire abort() call by 1000ms, so the 500ms no-response
// timer fires and the stop button shows a retryable "unconfirmed" state — on the stop
// button only (no chat toast, no sidebar error). The delayed abort then settles.
test("a slow stop becomes an explicit retry state, then reports late settlement", async ({
  page,
}) => {
  await drive(page, "slowabort");
  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await stop.click();

  await expect(stop).toHaveText("■ Stopping…");
  await expect(stop).toBeDisabled();

  await expect(stop).toHaveText("↻ Retry stop", { timeout: 1_500 });
  await expect(stop).toBeEnabled();

  // No chat notice appears — the unconfirmed state is consolidated to the
  // stop button only.
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast"),
  ).toHaveCount(0);

  // No sidebar error either.
  await expect(page.getByTestId("sidebar").getByTestId("toast")).toHaveCount(0);

  // The delayed abort settles at 1000ms — the terminal RunCompleted event
  // clears the turn. No "late confirmation" chat notice; the stop button +
  // working indicator simply disappear.
  await expect(stop).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast"),
  ).toHaveCount(0);
});

// The toolhold script arms a 1000ms delay on the terminal RunCompleted event
// after an accepted abort. The abort itself returns Ok immediately, so no false
// "unconfirmed" state appears.
test("stopping during a tool call does not produce a false unconfirmed state", async ({
  page,
}) => {
  await drive(page, "toolhold");
  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await stop.click();

  // The accepted abortResult clears the stop operation quickly (well under
  // the 500ms timer). The "Stopping…" transient is sub-100ms against an
  // instant-return mock, so we assert the negative: "↻ Retry stop" never
  // appears within the window — that's the core fix.
  await expect(stop).not.toHaveText("↻ Retry stop", { timeout: 1_500 });

  // No chat notice and no sidebar error.
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast"),
  ).toHaveCount(0);
  await expect(page.getByTestId("sidebar").getByTestId("toast")).toHaveCount(0);

  // After the 1000ms settle delay, the terminal RunCompleted event arrives
  // and settles the transcript — the working indicator disappears.
  await expect(page.getByTestId("working-indicator")).toHaveCount(0, {
    timeout: 2_000,
  });
  await expect(stop).toHaveCount(0);
});

// A stray mid-turn idle snapshot (turn still in flight) must not clear the Stop
// pill — the robust turnActive signal keeps the affordance up. Stop then ends the turn.
test("the Stop pill survives a stray mid-turn idle snapshot, then ends the turn", async ({
  page,
}) => {
  // The regression: a turn goes running, starts a tool, then an out-of-band
  // sessionUpdated(idle) lands while the tool is still executing — the folded
  // status reads idle and the server's running set clears, yet the run is plainly
  // still live. The robust turnActive signal must keep the stop affordance up.
  await drive(page, "staleidle");
  await expect(
    page.getByText("kicking off a command", { exact: false }),
  ).toBeVisible();
  // While the turn is still live, the tool renders as a bare card OUTSIDE any
  // collapsible folder — the user watches the call run before the turn settles.
  await expect(page.locator(".tool.summary")).toHaveCount(0);
  const tool = page
    .locator(".scroller > .tool, .work-body > .tool, .tool.running")
    .first();
  await expect(tool.locator(":scope > .head .name")).toHaveText(
    "Run shell command",
  );
  await expect(tool).toHaveClass(/running/);
  // A running card keeps a blinking status dot.
  await expect(tool.locator(":scope > .head .status")).toHaveText("○");

  // Wait for the stray idle snapshot to land server-side: the folded status flips to
  // "idle" (and stays — the turn never completes), proving the affordance no longer
  // depends on the folded status alone.
  await expect
    .poll(() =>
      page.request
        .get("/debug/state")
        .then((r) => r.json().then((s) => s.status)),
    )
    .toBe("idle");

  // …yet the stop pill + working indicator stay visible because a tool is still running.
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("working-indicator")).toBeVisible();

  // And Stop actually ends the turn: the affordance clears.
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
});

// The Stop button's tooltip names the Escape hotkey while a pending turn is in flight.
test("the Stop button names the Escape hotkey", async ({ page }) => {
  await drive(page, "pendinghold");
  await expect(page.getByTestId("stop-button")).toHaveAttribute(
    "title",
    "Stop the agent (Esc)",
  );
});

// Escape aborts a pending turn and restores the sent prompt to the composer (history
// is left alone — the orphaned user message stays in the transcript). The restore is
// deferred until the daemon accepts the stop.
test("Escape aborts a pending turn and restores the sent prompt to the composer", async ({
  page,
}) => {
  // A turn that's been sent but hasn't produced any output yet (thinking only) — the
  // case where the just-sent prompt should come back so it can be edited/resent.
  await drive(page, "pendinghold");
  await expect(page.getByText("Refactor the auth middleware")).toBeVisible();

  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();

  const ta = page.locator(".composer-wrap textarea");
  await expect(ta).toHaveValue("");
  await ta.focus();
  await page.keyboard.press("Escape");

  // The turn aborts: the Stop pill clears…
  await expect(stop).toHaveCount(0);
  // …and the prompt is back in the composer (history is left alone — the orphaned
  // user message stays in the transcript). The restore is deferred until the daemon
  // accepts the stop (AbortResult { accepted: true }), so it arrives a WS tick after
  // Escape — the timeout covers that async window.
  await expect(ta).toHaveValue("Refactor the auth middleware", { timeout: 2_000 });
  await expect(page.getByText("Refactor the auth middleware")).toBeVisible();
});

// A Stop button click aborts the turn but does NOT restore the prompt (only
// Esc-from-composer restores, via the restoreOnAccepted option).
test("Stop button click does not restore the prompt (only Esc does)", async ({
  page,
}) => {
  await drive(page, "pendinghold");
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();

  const ta = page.locator(".composer-wrap textarea");
  await expect(ta).toHaveValue("");

  await stop.click();

  // The turn aborts (Stop pill clears)…
  await expect(stop).toHaveCount(0);
  // …but the prompt is NOT restored into the composer (only Esc-from-composer
  // restores, via the restoreOnAccepted option).
  await expect(ta).toHaveValue("");
});

// Escape while typing a follow-up aborts the turn but preserves the in-progress draft
// (restore is skipped when the composer isn't empty).
test("Escape while typing a follow-up aborts but does not clobber the draft", async ({
  page,
}) => {
  await drive(page, "pendinghold");
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();

  const ta = page.locator(".composer-wrap textarea");
  await ta.fill("a different follow-up");
  await page.keyboard.press("Escape");

  // Still aborts the turn…
  await expect(stop).toHaveCount(0);
  // …but the in-progress text is preserved (restore is skipped when the box isn't empty).
  await expect(ta).toHaveValue("a different follow-up");
});

// Escape while offline is a no-op — the stop stays disabled, no duplicate error surfaces.
test("Escape while offline is a no-op — no duplicate error surfaces", async ({
  page,
}) => {
  await drive(page, "pendinghold"); // turn running, no output yet
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();

  // Drop the socket.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  await expect(stop).toBeDisabled();

  // The offline banner is the single contextual representation.
  await expect(
    page.getByText("Offline — the agent keeps running"),
  ).toBeVisible();

  const ta = page.locator(".composer-wrap textarea");
  await expect(ta).toHaveValue("");
  await ta.focus();
  await page.keyboard.press("Escape");

  // No sidebar error appears.
  await expect(page.getByTestId("sidebar").getByTestId("toast")).toHaveCount(0);
  // No chat toast appears.
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast"),
  ).toHaveCount(0);
  // The composer stays empty (no premature prompt restore).
  await expect(ta).toHaveValue("");
  // The stop button stays disabled (no "Retry stop" state).
  await expect(stop).toBeDisabled();
  await expect(stop).not.toHaveText("↻ Retry stop");
});

// A retried Esc-after-timeout restores the prompt via the second abort's requestId,
// not the superseded first one.
test("a retried Esc-after-timeout restores the prompt, not the superseded result", async ({
  page,
}) => {
  // slowabort delays the entire abort() by 1000ms, so the 500ms confirmation
  // timer fires first → markStopUnconfirmed → the stop is retryable.
  // pendinghold keeps the turn running (no RunCompleted) with only thinking
  // deltas, so abortRestoreText returns "Refactor the auth middleware".
  await drive(page, "pendinghold");
  await drive(page, "slowabort");
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();

  const ta = page.locator(".composer-wrap textarea");
  await expect(ta).toHaveValue("");
  await ta.focus();
  await page.keyboard.press("Escape"); // arms pendingAbortRestore (requestId: stop-1)

  // Wait for the unconfirmed state (the 500ms timer fires before the 1000ms
  // slowabort completes).
  await expect(stop).toHaveText("↻ Retry stop", { timeout: 1_500 });

  // Retry via Esc — arms a fresh pendingAbortRestore (requestId: stop-2).
  // The Stop button is "unconfirmed" (enabled), but Esc also works.
  await page.keyboard.press("Escape");

  // The delayed abort completes: AbortResult{requestId:stop-1, accepted:true}
  // arrives first (ignored by the requestId guard), then the second abort's
  // AbortResult{requestId:stop-2, accepted:true} fires the restore.
  await expect(ta).toHaveValue("Refactor the auth middleware", {
    timeout: 2_000,
  });
  // No duplicate restore, no sidebar error.
  await expect(page.getByTestId("sidebar").getByTestId("toast")).toHaveCount(0);
});
