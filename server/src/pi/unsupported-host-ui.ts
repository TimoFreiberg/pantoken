// When an extension calls a terminal-only host-UI capability that pilot's
// non-tui remote can't honor (e.g. `ui.custom()`), the bridge throws a typed
// error whose message carries a serialized ExtensionCompatibilityIssue. pi's
// ExtensionRunner catches that throw, attaches which extension/event raised it,
// and forwards it to the `bindExtensions({ onError })` listener — which parses
// it back out here and emits an `extensionCompatibilityIssue` event. The
// serialize/parse-through-the-message dance is the only channel: pi's
// ExtensionError.error is a plain string, so structured data has to ride inside
// it. Mirrors pi-gui's pi-sdk-driver/src/unsupported-host-ui.ts (the reference
// emit path), adapted to pilot's protocol type and wording.

import type { ExtensionCompatibilityIssue } from "@pilot/protocol";

const UNSUPPORTED_HOST_UI_PREFIX = "__PILOT_UNSUPPORTED_HOST_UI__:";

function createUnsupportedHostUiIssue(
  capability: string,
): ExtensionCompatibilityIssue {
  return {
    capability,
    classification: "terminal-only",
    message: genericUnsupportedCapabilityMessage(capability),
  };
}

function serializeUnsupportedHostUiIssue(
  issue: ExtensionCompatibilityIssue,
): string {
  return `${UNSUPPORTED_HOST_UI_PREFIX}${JSON.stringify(issue)}`;
}

/** Thrown by TUI-only bridge methods so the issue propagates with extension context. */
export function createUnsupportedHostUiError(capability: string): Error {
  return new Error(
    serializeUnsupportedHostUiIssue(createUnsupportedHostUiIssue(capability)),
  );
}

/** Recover the issue from an ExtensionError.error string, or undefined if it isn't one. */
export function parseUnsupportedHostUiErrorMessage(
  message: string,
): ExtensionCompatibilityIssue | undefined {
  if (!message.startsWith(UNSUPPORTED_HOST_UI_PREFIX)) {
    return undefined;
  }
  try {
    return JSON.parse(
      message.slice(UNSUPPORTED_HOST_UI_PREFIX.length),
    ) as ExtensionCompatibilityIssue;
  } catch {
    return undefined;
  }
}

function genericUnsupportedCapabilityMessage(capability: string): string {
  return `${labelForCapability(capability)} is not available in the pilot remote; run pi in a terminal for this workflow.`;
}

function labelForCapability(capability: string): string {
  switch (capability) {
    case "custom":
      return "Custom UI";
    case "onTerminalInput":
      return "Terminal input";
    case "setEditorComponent":
      return "Custom editor UI";
    case "setFooter":
      return "Footer UI";
    case "setHeader":
      return "Header UI";
    default:
      return capability.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }
}
