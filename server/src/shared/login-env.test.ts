import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveLoginShell } from "./login-env.js";

// resolveLoginShell decides which shell pilot runs to capture env. Only the resolution
// ORDER is unit-tested here — the actual capture spawns a real shell (smoke-tested
// manually + exercised by the server at startup), and persistence rides the e2e suite.
describe("resolveLoginShell", () => {
  test("a configured shell that exists wins", () => {
    expect(resolveLoginShell("/bin/bash")).toBe("/bin/bash");
  });

  test("a non-existent configured path is skipped for the next candidate ($SHELL)", () => {
    const prev = process.env.SHELL;
    process.env.SHELL = "/bin/bash";
    try {
      expect(resolveLoginShell("/no/such/shell")).toBe("/bin/bash");
    } finally {
      if (prev === undefined) delete process.env.SHELL;
      else process.env.SHELL = prev;
    }
  });

  test("null configured + no $SHELL falls back to an existing default shell", () => {
    const prev = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const r = resolveLoginShell(null);
      expect(r).not.toBeNull();
      expect(existsSync(r as string)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SHELL;
      else process.env.SHELL = prev;
    }
  });
});
