import { expect, test } from "@playwright/test";
import {
  drive,
  gotoFresh,
  openRightSidebar,
  waitForContextFixture,
} from "./helpers.js";

// The right context panel (RightSidebar) shows the active session's flagged files,
// background jobs, and todos — live session context, in that order (matches the
// polytoken TUI). Driven by the folded session state (flags/todos) and the server's
// JobsList broadcast (jobs). Open by default on desktop (same rule as the left
// Sidebar); toggled by ⌘⇧J or, while collapsed, the header's trailing-edge chevron
// (StatusHeader) — there's no more header hamburger. Has no "Context" title — just the
// collapse control, mirroring the left sidebar's title-less header.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const openPanel = openRightSidebar;

// Journey: the context panel renders flagged files and todos
test("the context panel renders flagged files and todos", async ({ page }) => {
  // Desktop default: already open (no click needed).
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  // Drive the context fixture → a snapshot with flags + todos lands.
  await drive(page, "context");
  await waitForContextFixture(page);

  // Flagged files render.
  const files = page.getByTestId("flagged-files");
  await expect(files).toBeVisible();
  await expect(files).toContainText("src/app.ts");
  await expect(files).toContainText("README.md");

  // Todos render with titles.
  const todos = page.getByTestId("todos");
  await expect(todos).toBeVisible();
  await expect(todos).toContainText("Wire up the right sidebar");
  await expect(todos).toContainText("Add e2e tests");
});

// Journey: sections render in order: flagged files, background jobs, todos
test("sections render in order: flagged files, background jobs, todos", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);

  // AC-equivalent to the old todos→jobs→files order: the TODO explicitly asks for
  // flagged files -> async jobs -> todos, matching the polytoken TUI.
  const testids = await page
    .getByTestId("right-sidebar")
    .locator("[data-testid]")
    .evaluateAll((els) =>
      els
        .map((el) => el.getAttribute("data-testid"))
        .filter(
          (id): id is string =>
            id === "flagged-files" ||
            id === "background-jobs" ||
            id === "todos",
        ),
    );
  expect(testids).toEqual(["flagged-files", "background-jobs", "todos"]);
});

// Journey: the context panel closes via its own control and reopens via the header arrow
test("the context panel closes via its own control and reopens via the header arrow", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  // Desktop default: open.
  await expect(panel).toHaveAttribute("data-open", "true");

  // Close via its own in-panel collapse control (no more header toggle button).
  await page.getByRole("button", { name: "Collapse context panel" }).click();
  await expect(panel).toHaveAttribute("data-open", "false");

  // Reopen via the header panel icon.
  await page.getByTestId("context-open").click();
  await expect(panel).toHaveAttribute("data-open", "true");
});

// Empty states for all three sections.
test("the context panel shows empty states when no flags/todos/jobs", async ({
  page,
}) => {
  await openPanel(page);

  // The default mock snapshot has no flags/todos → empty states.
  await expect(page.getByTestId("flagged-files")).toContainText(
    "No flagged files",
  );
  await expect(page.getByTestId("todos")).toContainText("No todos");
  await expect(page.getByTestId("background-jobs")).toContainText(
    "No background jobs",
  );
});

// Clicking a todo opens a detail view with full description + timestamp.
test("clicking a todo opens a detail view with full description", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);

  // Click the first todo.
  await page
    .getByTestId("todos")
    .getByText("Wire up the right sidebar")
    .click();

  // The detail view should appear with the full description.
  const detail = page.getByTestId("todo-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(
    "Add protocol types, event-map threading, and the drawer component",
  );

  // The "Created" meta row should be present (formatRelative output).
  await expect(detail).toContainText("Created");
});

// Deleting a todo from the detail view removes it from the list.
test("deleting a todo from the detail view removes it", async ({ page }) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);

  // Click "Review with subagent" (todo #3 — no other todo depends on it).
  await page.getByTestId("todos").getByText("Review with subagent").click();
  await expect(page.getByTestId("todo-detail")).toBeVisible();

  // Click delete.
  await page.getByTestId("todo-delete-btn").click();

  // The detail view closes.
  await expect(page.getByTestId("todo-detail")).toHaveCount(0);

  // The todo is no longer in the sidebar (the mock emits a SessionUpdated
  // snapshot with the updated todo list).
  await expect(page.getByTestId("todos")).not.toContainText(
    "Review with subagent",
  );
});

// Background jobs render with type, status, and output summary.
test("background jobs section renders fixture jobs", async ({ page }) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);

  // The context script populates the mock's job fixtures; the hub broadcasts
  // JobsList on the SessionUpdated.
  const jobs = page.getByTestId("background-jobs");

  // The context fixture has 3 jobs (a running subagent, a completed shell,
  // and a completed subagent).
  await expect(jobs).toContainText("general-purpose");
  await expect(jobs).toContainText("shell_exec");
  await expect(jobs).toContainText("researcher");
});

async function driveVisualJobs(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const mock = (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock;
    if (!mock) throw new Error("mock driver hook is unavailable");
    mock("jobvisual");
  });
  await openPanel(page);
  await expect(page.getByTestId("background-jobs").locator(".job-btn")).toHaveCount(4);
}

// Clicking a job opens a detail view with the job's identity and context.
test("clicking a job opens a detail view with the job's details", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);

  // Wait for jobs to render.
  const jobs = page.getByTestId("background-jobs");
  await expect(jobs).toContainText("general-purpose");

  // Click the first job (the running subagent). Subagent jobs render their
  // captured-transcript section instead of the output tail; the mock provides
  // no transcript for this job, so the placeholder shows, alongside the job's
  // meta rows (handle, model).
  await jobs.getByText("general-purpose").first().click();
  const detail = page.getByTestId("job-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("general-purpose:code-reviewer");
  await expect(detail).toContainText("anthropic/claude-sonnet-4-20250514");
  await expect(detail).toContainText("Loading subagent transcript");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // The completed shell job's detail renders its output tail (shell jobs show
  // outputTail, not a transcript).
  await jobs.getByText("shell_exec").click();
  const shellDetail = page.getByTestId("job-detail");
  await expect(shellDetail).toBeVisible();
  await expect(shellDetail).toContainText("cargo clippy");
  await expect(shellDetail).toContainText("0 warnings, 0 errors");
});

// The visual cue is scoped to running subagents, not shell jobs or completed work.
test("running subagent pulse is limited to active subagents", async ({ page }) => {
  await driveVisualJobs(page);

  const jobs = page.getByTestId("background-jobs");
  const runningSubagent = jobs.locator('.job-item[data-job-kind="subagent"][data-job-status="running"]');
  const runningShell = jobs.locator('.job-item[data-job-kind="shell"][data-job-status="running"]');
  const completedShell = jobs.locator('.job-item[data-job-kind="shell"][data-job-status="completed"]');
  const completedSubagent = jobs.locator('.job-item[data-job-kind="subagent"][data-job-status="completed"]');

  await expect(runningSubagent).toHaveCount(1);
  await expect(runningSubagent.locator('[data-job-kind-marker="subagent"]')).toBeVisible();
  await expect.poll(() => runningSubagent.locator(".job-status-icon").evaluate((el) => {
    const style = getComputedStyle(el);
    return { name: style.animationName, iterations: style.animationIterationCount };
  })).toMatchObject({ iterations: "infinite" });
  await expect.poll(() => runningSubagent.locator(".job-status-icon").evaluate((el) => getComputedStyle(el).animationName))
    .toMatch(/^svelte-[a-z0-9]+-subagent-status-pulse$/);

  for (const [row, kind] of [
    [runningShell, "shell"],
    [completedShell, "shell"],
    [completedSubagent, "subagent"],
  ] as const) {
    await expect(row).toHaveCount(1);
    await expect(row.locator(`[data-job-kind-marker="${kind}"]`)).toBeVisible();
    await expect(row.locator(".job-status-icon")).toHaveCSS("animation-name", "none");
  }
});

// Reduced motion keeps the active status cue static and prevents geometry changes
// in the narrow phone context view.
test("running subagent pulse is disabled with reduced motion and remains geometrically stable at 412x915", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await driveVisualJobs(page);

  const jobs = page.getByTestId("background-jobs");
  const row = jobs.locator('.job-item[data-job-kind="subagent"][data-job-status="running"]');
  const marker = row.locator('[data-job-kind-marker="subagent"]');
  const completed = jobs.locator('.job-item[data-job-kind="subagent"][data-job-status="completed"]');
  await expect(marker).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(completed).toHaveCount(1);
  await expect(row.locator(".job-status-icon")).toHaveCSS("animation-name", "none");
  await expect.poll(async () => {
    const runningColor = await row.locator(".job-status-icon").evaluate((el) => getComputedStyle(el).color);
    const completedColor = await completed.locator(".job-status-icon").evaluate((el) => getComputedStyle(el).color);
    return runningColor !== completedColor;
  }).toBe(true);

  const first = { row: await row.boundingBox(), marker: await marker.boundingBox() };
  expect(first.row).not.toBeNull();
  expect(first.marker).not.toBeNull();
  await expect.poll(async () => {
    const animationName = await row.locator(".job-status-icon").evaluate((el) => getComputedStyle(el).animationName);
    const current = { row: await row.boundingBox(), marker: await marker.boundingBox() };
    if (animationName !== "none" || !current.row || !current.marker || !first.row || !first.marker) {
      return false;
    }
    return [current.row, current.marker].every((box, i) => {
      const baseline = i === 0 ? first.row : first.marker;
      if (!baseline) {
        return false;
      }
      return (["x", "y", "width", "height"] as const).every((key) => Math.abs(box[key] - baseline[key]) <= 1);
    });
  }).toBe(true);
});

// Q5 guard: an open detail sheet (now z=100/101, above agent-driven overlays
// like PlanView z=60/61) is user-initiated and must be trivially dismissible so
// it never durably blocks an agent-driven overlay. Esc closes it, restoring the
// underlying view.
test("an open detail sheet is dismissible via Esc and does not durably block", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);
  const jobs = page.getByTestId("background-jobs");
  await expect(jobs).toContainText("general-purpose");
  await jobs.getByText("general-purpose").first().click();

  const detail = page.getByTestId("job-detail");
  await expect(detail).toBeVisible();

  // Esc closes the detail — no lingering modal blocking the app.
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // The panel and its jobs are still interactive underneath.
  await expect(jobs).toContainText("general-purpose");
});

// Copy-path button on a flagged file copies to clipboard.
test("copy-path button copies flagged file path to clipboard", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);

  // Wait for flagged files to render.
  const files = page.getByTestId("flagged-files");
  await expect(files).toContainText("src/app.ts");

  // Click the copy button for the first file.
  await page.getByTestId("copy-path-src/app.ts").click();

  // Assert the clipboard contains the path.
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("src/app.ts");
});

// Client-side jobs refresh updates the UI.
test("client-side jobs refresh updates UI after mock script", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");
  await waitForContextFixture(page);

  // Wait for default jobs (populated by the context script).
  const jobs = page.getByTestId("background-jobs");
  await expect(jobs).toContainText("general-purpose");
  await expect(jobs).toContainText("researcher");

  // Drive the "jobs" script which swaps the mock's job fixtures.
  await drive(page, "jobs");

  // Drive "idle" to trigger a SessionUpdated → hub re-fetches jobs via
  // on_event → broadcasts JobsList with the "jobs" script's fixtures.
  // (The "idle" script doesn't touch self.jobs, so the swapped fixtures
  // survive.)
  await drive(page, "idle");

  // The new job should appear (its output tail is unique).
  await expect(jobs).toContainText("Investigating the codebase");
  // The old jobs should be gone.
  await expect(jobs).not.toContainText("researcher");
});

// ── Working directory footer (cwd + stack depth) ─────────────────────────

test("the session footer shows the cwd and stack-depth badge", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "cwd");

  const footer = page.getByTestId("session-footer");
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("Working directory");

  // The cwd path is middle-ellipsized but the full path is in the title attr.
  const cwdPath = page.getByTestId("cwd-path");
  await expect(cwdPath).toHaveAttribute(
    "title",
    "/Users/timo/src/pantoken/client",
  );
  await expect(cwdPath).toContainText("pantoken/client");

  // Stack-depth badge shows when > 0.
  const badge = page.getByTestId("cwd-stack-depth");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Stack · 2");
});

// Journey: clicking the cwd path copies the full path to clipboard
test("clicking the cwd path copies the full path to clipboard", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "cwd");

  await page.getByTestId("cwd-path").click();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("/Users/timo/src/pantoken/client");
});

// Journey: the footer shows the project root with no stack badge at depth 0
test("the footer shows the project root with no stack badge at depth 0", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "cwdroot");

  const footer = page.getByTestId("session-footer");
  await expect(footer).toBeVisible();

  const cwdPath = page.getByTestId("cwd-path");
  await expect(cwdPath).toHaveAttribute(
    "title",
    "/Users/timo/src/pantoken",
  );

  // No stack-depth badge when depth is 0.
  await expect(page.getByTestId("cwd-stack-depth")).toHaveCount(0);
});

// Journey: the footer stays pinned when the sidebar content overflows
test("the footer stays pinned when the sidebar content overflows", async ({
  page,
}) => {
  // Force a small viewport so the context fixture's content overflows.
  await page.setViewportSize({ width: 1280, height: 400 });
  await openPanel(page);
  // Drive "cwd" first to set the live cwd (footer renders), then "context"
  // to populate flagged files + todos + jobs (forces overflow). The fold's
  // overwrite-guard preserves cwd since "context"'s snapshot omits it.
  await drive(page, "cwd");
  await drive(page, "context");
  await waitForContextFixture(page);

  const footer = page.getByTestId("session-footer");
  await expect(footer).toBeVisible();

  // The footer must be within the viewport (not scrolled off-screen).
  const footerBox = await footer.boundingBox();
  expect(footerBox).not.toBeNull();
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(400);

  // The .content div must be scrollable (overflowing).
  const content = page.locator(".right-sidebar .content");
  const isScrollable = await content.evaluate((el) => {
    const h = el as HTMLElement;
    return h.scrollHeight > h.clientHeight;
  });
  expect(isScrollable).toBe(true);
});
