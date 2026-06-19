import { describe, expect, test } from "bun:test";
import {
  createUnsupportedHostUiError,
  parseUnsupportedHostUiErrorMessage,
} from "./unsupported-host-ui.js";

describe("unsupported-host-ui", () => {
  test("createUnsupportedHostUiError round-trips through parse", () => {
    const err = createUnsupportedHostUiError("custom");
    const issue = parseUnsupportedHostUiErrorMessage(err.message);
    expect(issue).toEqual({
      capability: "custom",
      classification: "terminal-only",
      message:
        "Custom UI is not available in the pilot remote; run pi in a terminal for this workflow.",
    });
  });

  test("parse returns undefined for an ordinary error message", () => {
    expect(parseUnsupportedHostUiErrorMessage("boom")).toBeUndefined();
  });

  test("parse returns undefined when the payload is malformed", () => {
    expect(
      parseUnsupportedHostUiErrorMessage("__PILOT_UNSUPPORTED_HOST_UI__:{nope"),
    ).toBeUndefined();
  });
});
