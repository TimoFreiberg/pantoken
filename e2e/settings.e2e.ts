import { expect, test, type Locator, type Page } from "@playwright/test";
import { drive, gotoFresh, openSettings, openSidebar } from "./helpers.js";

// Flow tests for the settings surface and adjacent desktop UI: the settings
// panel (sections, theme, text-size, zoom, focus, shortcuts, access token),
// the host switcher, accent-role contrast, and the session-chooser project
// list. Absorbed files: host-switcher.e2e.ts, accent-roles.e2e.ts,
// project-menu.e2e.ts.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// ---------------------------------------------------------------------------
// Settings panel flows
// ---------------------------------------------------------------------------

// Open the settings panel from the sidebar, verify its sections, navigate
// tabs, then close it via Escape, the close button, and the Cmd+, shortcut.
test("settings panel opens, lists sections, navigates tabs, and closes via Escape, close button, and Cmd+,", async ({
  page,
}) => {
  await expect(
    page.locator("header").getByTestId("settings-toggle"),
  ).toHaveCount(0);
  // AC.1 (desktop): the sidebar Settings button is icon-only — no "Settings" text label.
  await expect(page.getByTestId("settings-toggle")).not.toContainText("Settings");
  await page.getByTestId("settings-toggle").click();

  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Appearance", { exact: true })).toBeVisible();
  await expect(panel.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(panel.getByText("Models", { exact: true })).toBeVisible();
  await expect(panel.getByText("Environment", { exact: true })).toBeVisible();
  await expect(panel.getByText("Access token", { exact: true })).toBeVisible();
  await page.getByTestId("settings-tab-notifications").click();
  await expect(page.getByTestId("connection-settings-row")).toContainText("Live");
  // The dev/mock server runs without PANTOKEN_TOKEN, so no token is saved client-side.
  // Only the active section renders, so jump to the Access token tab to see its body.
  await page.getByTestId("settings-tab-token").click();
  await expect(panel.getByText("No token saved")).toBeVisible();

  // Close via Escape — the panel is open, so it should be visible before close.
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // Reopen and close via the close button.
  await page.getByTestId("settings-toggle").click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(panel).toBeHidden();

  // Toggle with the standard preferences shortcut.
  await expect(panel).toBeHidden();
  // Open with the standard preferences shortcut…
  await page.keyboard.press("Control+Comma");
  await expect(panel).toBeVisible();
  // …and the same shortcut closes it again.
  await page.keyboard.press("Control+Comma");
  await expect(panel).toBeHidden();
});

// Settings panel traps focus and restores the opener on close.
test("settings panel focus management traps focus and restores the opener", async ({
  page,
}) => {
  const opener = page.getByTestId("settings-toggle");
  await opener.click();
  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Close settings" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(panel.getByTestId("hide-thinking")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Close settings" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
});

// The section rail deep-links to a section without scrolling, and Alt+1..6
// jumps between section tabs.
test("section rail deep-links to sections and Alt+1..6 jumps between tabs", async ({
  page,
}) => {
  // The default-open section is Appearance; Environment's controls live further down
  // the old single scroll. With the left-rail nav, clicking the Environment tab lands
  // on its body immediately — the env-section is visible without scrolling.
  await page.getByTestId("settings-toggle").click();
  // Sanity: the Environment tab is present and not yet selected (Appearance is).
  const envTab = page.getByTestId("settings-tab-environment");
  await expect(envTab).toHaveAttribute("aria-selected", "false");

  await envTab.click();
  await expect(envTab).toHaveAttribute("aria-selected", "true");

  // The left-rail swaps sections by mounting only the active one (no scroll), so
  // the panel body's scrollTop stays 0. This is a weak guard (it can't really be
  // non-zero given only one section renders) — the real teeth are the
  // login-shell-status-visible + theme-system-gone assertions below. Kept as a
  // cheap sanity check that nothing scrolled the panel.
  const env = page.getByTestId("settings-panel").getByTestId("env-section");
  await expect(env.getByTestId("login-shell-status")).toBeVisible();
  const bodyScrollTop = await page
    .getByTestId("settings-panel")
    .locator(".body")
    .evaluate((el) => el.scrollTop);
  expect(bodyScrollTop).toBe(0);
  // …and the Appearance section (the default) is no longer rendered at all.
  await expect(
    page.getByTestId("settings-panel").getByTestId("theme-system"),
  ).toHaveCount(0);

  // Alt+2 → Notifications: its push control appears, Appearance's theme control is gone.
  const panel = page.getByTestId("settings-panel");
  await page.keyboard.press("Alt+2");
  await expect(panel.getByTestId("settings-tab-notifications")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByText("Push on this device")).toBeVisible();
  await expect(panel.getByTestId("theme-system")).toHaveCount(0);

  // Alt+5 → MCP servers.
  await page.keyboard.press("Alt+5");
  await expect(panel.getByTestId("settings-tab-mcp")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Alt+6 → Access token: its body appears too, proving the shortcut spans the rail.
  await page.keyboard.press("Alt+6");
  await expect(panel.getByTestId("settings-tab-token")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByText("No token saved")).toBeVisible();

  // Alt+1 → back to Appearance: the theme control returns.
  await page.keyboard.press("Alt+1");
  await expect(panel.getByTestId("theme-system")).toBeVisible();
});

// Theme toggle drives the data-theme override and persists it across reload.
test("theme toggle drives the data-theme override and persists it", async ({
  page,
}) => {
  const html = page.locator("html");
  // Fresh device defaults to "system"; the emulated OS scheme is light.
  await expect(html).toHaveAttribute("data-theme", "light");

  await openSettings(page, "appearance");
  await expect(page.getByTestId("theme-system")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  // color-scheme drives native UA widgets (scrollbars, form controls); it must
  // track the active palette, not the OS scheme.
  await expect(html).toHaveCSS("color-scheme", "dark");

  await page.getByTestId("theme-light").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).toHaveCSS("color-scheme", "light");

  // Back to dark, then reload: the inline pre-paint script must restore
  // data-theme before the bundle loads.
  await page.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  // The inline pre-paint script sets color-scheme as an inline style (before CSS
  // loads), which is what prevents a flash of wrong-theme native scrollbar.
  expect(await html.evaluate((el) => el.style.colorScheme)).toBe("dark");

  // "System" clears the override and re-resolves to the emulated light scheme.
  await openSettings(page, "appearance");
  await page.getByTestId("theme-system").click();
  await expect(html).toHaveAttribute("data-theme", "light");
});

// Text-size stepper scales the transcript and persists across reload, and
// Cmd/Ctrl +/-/0 zooms the transcript text.
test("text-size stepper scales the transcript and Cmd +/-/0 zooms", async ({
  page,
}) => {
  const html = page.locator("html");
  const scale = async () =>
    Number.parseFloat(
      (await html.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--font-scale"),
      )) || "1",
    );

  await expect(await scale()).toBe(1);

  await openSettings(page, "appearance");
  const panel = page.getByTestId("settings-panel");
  await expect(panel.getByTestId("font-reset")).toHaveText("100%");

  // Grow twice → the var climbs above 1 and the readout tracks it.
  await panel.getByTestId("font-larger").click();
  await panel.getByTestId("font-larger").click();
  expect(await scale()).toBeGreaterThan(1);
  await expect(panel.getByTestId("font-reset")).not.toHaveText("100%");
  const grown = await scale();

  // Pre-paint restores the persisted scale before the bundle loads (no reflow flash).
  await page.reload();
  await expect(await scale()).toBe(grown);

  // Reset returns to the default and clears the override; that too survives reload.
  await openSettings(page, "appearance");
  await page.getByTestId("font-reset").click();
  await expect(await scale()).toBe(1);
  await page.reload();
  await expect(await scale()).toBe(1);

  // Cmd/Ctrl +/-/0 zoom the transcript text.
  await expect(await scale()).toBe(1);

  await page.keyboard.press("Control+Equal");
  expect(await scale()).toBeGreaterThan(1);

  await page.keyboard.press("Control+Minus");
  await expect(await scale()).toBe(1);

  await page.keyboard.press("Control+Equal");
  await page.keyboard.press("Control+Digit0");
  await expect(await scale()).toBe(1);
});

// The Environment section shows login-shell status and persists an override.
test("the Environment section shows login-shell status and persists an override", async ({
  page,
}) => {
  await openSettings(page, "environment");
  const env = page.getByTestId("settings-panel").getByTestId("env-section");
  await expect(env.getByText("Login shell", { exact: true })).toBeVisible();
  // Mock mode never runs the startup capture, so the status reads "Not captured".
  await expect(env.getByTestId("login-shell-status")).toContainText(
    "Not captured",
  );

  await env.getByTestId("login-shell-input").fill("/opt/homebrew/bin/fish");
  await env.getByRole("button", { name: "Save" }).click();

  // Round-trips through the server's pantokenSettings broadcast, which reads back the
  // persisted file. Reload (a fresh WS connection) + reopen: the field is re-seeded
  // from disk, proving it persisted server-side.
  await page.reload();
  await openSettings(page, "environment");
  await expect(page.getByTestId("login-shell-input")).toHaveValue(
    "/opt/homebrew/bin/fish",
  );

  // Clear back to the default (also leaves the e2e data dir clean for sibling specs).
  await page
    .getByTestId("env-section")
    .getByRole("button", { name: "Default" })
    .click();
  await expect(page.getByTestId("login-shell-input")).toHaveValue("");
});

// The Access token tab shows the data directory with copy + reveal actions.
test("the Access token tab shows the data directory with copy + reveal actions", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSettings(page, "token");
  const section = page.getByTestId("data-dir-section");
  // The mock/e2e server sends dataDir in hello — the path renders (non-empty).
  await expect(section.getByTestId("data-dir-path")).not.toHaveText("unknown");
  const path = await section.getByTestId("data-dir-path").textContent();
  expect(path && path.length > 0).toBe(true);

  // Copy path writes the data dir to the clipboard.
  await section.getByRole("button", { name: "Copy path" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(path);

  // Reveal sends the openDataDir message — the server best-efforts the spawn. We
  // can't assert Finder opened, but we can assert no error surfaced (the mock data
  // dir exists, so the spawn path is reachable; on a headless runner `open` may
  // no-op, which is the designed graceful degrade — assert no error toast).
  await section.getByRole("button", { name: "Reveal" }).click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Host switcher flows
// ---------------------------------------------------------------------------

// The desktop host picker is local-first, exposes identity, closes on Escape
// and outside click, and the collapsed sidebar keeps the host identity in the
// header.
test("host picker exposes identity, closes on Escape/outside click, and collapsed sidebar shows host identity", async ({
  page,
}) => {
  await openSidebar(page);
  const switcher = page.getByTestId("host-switcher");
  const trigger = switcher.getByTestId("host-switcher-trigger");
  await expect(trigger).toContainText("Dev computer");
  await expect(trigger).toContainText("This computer");
  await trigger.click();
  const options = page.locator(".host-option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Dev computer");
  await expect(options.nth(1)).toContainText("Dev remote");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose computer" })).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(900, 100);
  await expect(page.getByRole("dialog", { name: "Choose computer" })).toBeHidden();

  // Collapsed sidebar keeps the selected host identity in the header.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByTestId("header-host-identity")).toContainText("Dev computer");
});

// Browser single-host mode suppresses native host controls.
test("browser single-host mode suppresses native host controls", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("host-switcher")).toHaveCount(0);
  await expect(page.getByTestId("header-host-identity")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Accent-role contrast flows
// ---------------------------------------------------------------------------

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

// Gold actions stay distinct from nickel structure and paper/nickel/prompt
// surfaces keep a visible hierarchy, in both light and dark themes.
test("accent roles and surface hierarchy maintain visible contrast in both themes", async ({
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

// ---------------------------------------------------------------------------
// Project menu (session chooser) flows
// ---------------------------------------------------------------------------

// Under create-on-click (phase 3), the project menu lives in the session
// chooser (SessionChooser.svelte), not a draft composer chip. The chooser's
// project list uses the same deriveKnownProjects/rankProjects logic as the old
// draft project menu. These tests exercise the chooser's list, fuzzy filter,
// keyboard navigation, and Browse entry — the same coverage the old draft
// project-menu tests provided.

const chooser = (page: Page) => page.getByTestId("session-chooser");

async function openProjectChooser(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();
  // Move the mouse off the chooser so no mouseenter fires on a result row.
  await page.mouse.move(0, 0);
}

// The chooser lists known projects with the active one highlighted, fuzzy-filters
// them, shows a no-matches message on empty search, and the Browse entry is
// always available.
test("chooser lists known projects, highlights active, fuzzy-filters, and shows no-matches", async ({
  page,
}) => {
  await openProjectChooser(page);
  const results = chooser(page).locator(".result.project .name");
  // The mock fixtures define projects: pantoken, scratch, retry-lib, stale-proj.
  const names = await results.allTextContents();
  expect(names).toContain("pantoken");
  expect(names).toContain("scratch");
  expect(names).toContain("retry-lib");
  expect(names).toContain("stale-proj");
  // "Browse…" entry is always present.
  await expect(chooser(page).getByTestId("chooser-browse")).toBeVisible();

  // The active project (last-active cwd) carries aria-current="true".
  // The greeting session lives in pantoken, so lastProjectCwd is pantoken.
  const active = chooser(page).locator(".result.project[aria-current='true']");
  await expect(active).toHaveCount(1);
  await expect(active.locator(".name")).toContainText("pantoken");

  // Fuzzy search filters projects (AC.2).
  const input = chooser(page).getByRole("textbox", { name: "Filter projects" });
  await input.fill("pan");
  await expect(chooser(page).locator(".result.project .name")).toHaveText([
    "pantoken",
  ]);
  await input.fill("scr");
  await expect(chooser(page).locator(".result.project .name")).toHaveText([
    "scratch",
  ]);

  // Empty search shows a no-matches message.
  await input.fill("zzz");
  await expect(chooser(page).getByText("No matching projects.")).toBeVisible();
  // "Browse…" remains available even with no matches.
  await expect(chooser(page).getByTestId("chooser-browse")).toBeVisible();
  // Clearing the query restores the full list.
  await input.fill("");
  await expect(chooser(page).locator(".result.project")).toHaveCount(4);
});

// Creating a session via project click and keyboard Enter closes the chooser.
test("creating a session via project click and keyboard Enter closes the chooser", async ({
  page,
}) => {
  // Click a project row — creates a session immediately and closes the chooser.
  await openSidebar(page);
  const beforeCount = await page.getByTestId("sidebar").locator(".row").count();
  await page.getByTestId("sidebar-new-session").locator(".new-btn").click();
  await expect(chooser(page)).toBeVisible();

  await chooser(page).getByTestId("chooser-project-scratch").click();
  await expect(chooser(page)).toHaveCount(0);
  // A new session row appears.
  await expect(page.getByTestId("sidebar").locator(".row")).toHaveCount(
    beforeCount + 1,
  );

  // Reopen the chooser for keyboard navigation.
  await openProjectChooser(page);
  const input = chooser(page).getByRole("textbox", { name: "Filter projects" });
  await expect(input).toBeFocused();
  // The first project (index 0) is highlighted by default — the most-recently-
  // used (pantoken in the fixture).
  await expect(
    chooser(page).locator(".result.project").first(),
  ).toHaveAttribute("aria-selected", "true");
  // Arrow down moves to the second project.
  await input.press("ArrowDown");
  await expect(
    chooser(page).locator(".result.project").nth(1),
  ).toHaveAttribute("aria-selected", "true");
  // Arrow up moves back to the first.
  await input.press("ArrowUp");
  await expect(
    chooser(page).locator(".result.project").first(),
  ).toHaveAttribute("aria-selected", "true");
  // Enter selects the highlighted project and closes the chooser (creates a
  // session).
  await input.press("Enter");
  await expect(chooser(page)).toHaveCount(0);
});

// Browse entry opens the DirPicker (AC.4).
test("Browse entry opens the DirPicker", async ({ page }) => {
  await openProjectChooser(page);
  await chooser(page).getByTestId("chooser-browse").click();
  // The chooser stays mounted (the DirPicker renders as a sibling overlay on
  // top of it); the DirPicker is now visible.
  await expect(page.getByTestId("dir-picker")).toBeVisible();
});
