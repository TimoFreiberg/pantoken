import { defineConfig } from "vitest/config";

// Vitest config — the test runner. The `test` script in package.json invokes
// `vitest run`. test-setup.ts (previously bunfig.toml [test].preload) is wired
// via setupFiles and polyfills Svelte 5 runes + minimal DOM globals for unit tests.
export default defineConfig({
  test: {
    setupFiles: ["./test-setup.ts"],
    environment: "node",
    include: [
      "protocol/src/**/*.test.ts",
      "client/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // Scripts tests may spawn subprocesses; allow generous timeout.
    testTimeout: 30_000,
    // Vitest 4.x has an unresolved worker-teardown race: if a console.log
    // (from vitest internals, Svelte dev warnings, or a timer callback) is
    // in flight when the worker closes, the pending onUserConsoleLog RPC
    // rejects as EnvironmentTeardownError (vitest#8649, #9458). No fix in
    // 4.1.x. disableConsoleIntercept eliminates the RPC entirely.
    disableConsoleIntercept: true,
    // Use forks pool for more stable teardown.
    pool: "forks",
  },
});
