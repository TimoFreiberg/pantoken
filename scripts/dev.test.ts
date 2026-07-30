import { describe, it, expect } from "vitest";

// Test the build-system selection logic without importing scripts/dev.ts
// (which runs top-level boot code on import).
import { parseBuck2ShowOutput } from "./lib/build-server.js";

describe("parseBuck2ShowOutput", () => {
  it("parses a single-line output", () => {
    const stdout =
      "//server-rs/pantoken-server:pantoken_server buck-out/v2/gen/server-rs/pantoken-server/pantoken_server";
    expect(parseBuck2ShowOutput(stdout)).toBe(
      "buck-out/v2/gen/server-rs/pantoken-server/pantoken_server",
    );
  });

  it("parses the last line of multi-line output", () => {
    const stdout = `some warning text
//server-rs/pantoken-server:pantoken_server buck-out/v2/gen/server-rs/pantoken-server/pantoken_server`;
    expect(parseBuck2ShowOutput(stdout)).toBe(
      "buck-out/v2/gen/server-rs/pantoken-server/pantoken_server",
    );
  });

  it("throws on empty output", () => {
    expect(() => parseBuck2ShowOutput("")).toThrow("no output");
  });

  it("throws on whitespace-only output", () => {
    expect(() => parseBuck2ShowOutput("   \n  ")).toThrow("no output");
  });

  it("throws on single-field output (missing path)", () => {
    expect(() =>
      parseBuck2ShowOutput("//server-rs/pantoken-server:pantoken_server"),
    ).toThrow("unexpected buck2 --show-output format");
  });
});
