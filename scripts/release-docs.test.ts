import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const guide = readFileSync(resolve(import.meta.dirname, "../docs/local-ci-and-release.md"), "utf8");
const readinessStart = guide.indexOf("## Release readiness");
const nextHeading = readinessStart < 0 ? -1 : guide.indexOf("\n## ", readinessStart + "## Release readiness".length);
const readinessSection = guide.slice(readinessStart, nextHeading < 0 ? guide.length : nextHeading);

describe("release-readiness documentation contract", () => {
  it("describes quiet success and complete failure diagnostics for readiness children", () => {
    expect(readinessSection).toMatch(/child commands capture stdout and stderr on success/i);
    expect(readinessSection).toMatch(/start status and a stop status with the elapsed duration/i);
    expect(readinessSection).toMatch(/captured stdout and stderr are printed after the failed stop status/i);
    expect(readinessSection).toMatch(/only to readiness child commands/i);
    expect(readinessSection).toMatch(/outer release VCS/i);
    expect(readinessSection).toMatch(/standalone artifact builds/i);
  });
});
