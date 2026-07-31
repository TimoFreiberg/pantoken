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
    // Use forks pool for more stable teardown (avoids EnvironmentTeardownError
    // race conditions with async console.log in worker threads).
    pool: "forks",
  },
});
