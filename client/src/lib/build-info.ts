// The git stamp baked in at build time (vite.config.ts `define`). `__BUILD_*__` are
// replaced with string literals during the build; in dev they resolve via the worktree.
export const buildHash = __BUILD_HASH__;
export const buildDate = __BUILD_DATE__;
// Un-abbreviated sha for exact comparison against `hello.buildSha` (the sha of
// the bundle the server is serving) — "" when git was unreachable at build time.
export const buildFullHash = __BUILD_FULL_HASH__;

// Nearest release tag reachable from the built commit (e.g. "v0.2.15"); "" when no
// tag was resolvable at build time.
export const buildTag = __BUILD_TAG__;

// Compact version label for the sidebar footer, e.g. "v0.2.15 · 4b56b3b · 2026-06-18".
// Drops the tag/date pieces that weren't resolvable at build time (hash is then "dev").
export const buildLabel = [buildTag, buildHash, buildDate]
  .filter(Boolean)
  .join(" · ");
