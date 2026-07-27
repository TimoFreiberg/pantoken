import { describe, expect, it } from "vitest";
import { sessionSubtitle } from "./session-subtitle.js";

describe("sessionSubtitle", () => {
  const PROJECT = "/Users/timo/src/pantoken";

  it("shows the project basename at the project root", () => {
    expect(sessionSubtitle({ cwd: PROJECT })).toBe("pantoken");
  });

  it("shows the project basename when liveCwd equals the project root", () => {
    expect(sessionSubtitle({ cwd: PROJECT, liveCwd: PROJECT })).toBe("pantoken");
  });

  it("shows a deviation suffix after pushd to a subdirectory", () => {
    expect(
      sessionSubtitle({ cwd: PROJECT, liveCwd: `${PROJECT}/client` }),
    ).toBe("pantoken › client");
  });

  it("shows a deeper relative path", () => {
    expect(
      sessionSubtitle({ cwd: PROJECT, liveCwd: `${PROJECT}/client/src` }),
    ).toBe("pantoken › client/src");
  });

  it("shows a tilde-prefixed path outside the project", () => {
    process.env.HOME = "/Users/timo";
    expect(
      sessionSubtitle({ cwd: PROJECT, liveCwd: "/Users/timo/src/other" }),
    ).toBe("pantoken › ~/src/other");
  });

  it("falls back to the project basename when liveCwd is absent", () => {
    expect(sessionSubtitle({ cwd: PROJECT })).toBe("pantoken");
  });

  it("returns 'no session' when there is no project cwd", () => {
    expect(sessionSubtitle({})).toBe("no session");
    expect(sessionSubtitle({ cwd: "" })).toBe("no session");
    expect(sessionSubtitle({ cwd: undefined })).toBe("no session");
  });
});
