import { defineConfig } from "vitest/config";

// Vitest config — replaces bun:test as the test runner. Works under both
// `bunx vitest run` (Bun) and `npx vitest run` (Node). The `test` script in
// package.json invokes `bunx vitest run`; `test:node` invokes `npx vitest run`.
//
// test-setup.ts (previously bunfig.toml [test].preload) is wired via setupFiles
// and polyfills Svelte 5 runes + minimal DOM globals for unit tests.
export default defineConfig({
  test: {
    setupFiles: ["./test-setup.ts"],
    environment: "node",
    include: [
      "protocol/src/**/*.test.ts",
      "client/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // 3 update-headless.sh integration tests require a real macOS launchd
    // service environment and fail outside it — pre-existing, unrelated to
    // the Vitest migration. See docs/toolchain-baseline.md.
    testTimeout: 30_000,
  },
});
