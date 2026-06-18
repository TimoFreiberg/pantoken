// Reactive "is the app currently in dark mode?" — mirrors the theme resolution that
// lib/theme.ts writes onto <html data-theme>. A single app-lifetime MutationObserver
// keeps it in sync across explicit toggles AND live OS "system" flips, since both
// funnel through applyThemeMode() setting data-theme. Used to drive markstream-svelte's
// `isDark` prop (the app toggles theme via data-theme, not a `.dark` class, so the
// renderer's dark styles must be switched explicitly).

function read(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark"
  );
}

let dark = $state(read());

if (typeof document !== "undefined") {
  new MutationObserver(() => {
    dark = read();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

/** Reactive: true while the resolved theme is dark. Read it in a template/$derived. */
export function isDark(): boolean {
  return dark;
}
