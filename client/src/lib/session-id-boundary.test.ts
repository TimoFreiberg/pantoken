import { describe, expect, test } from "vitest";
import {
  parseClientMessage,
  sessionId,
  type ClientMessage,
} from "@pantoken/protocol";
import {
  loadNamespacedScalar,
  persistNamespacedScalar,
} from "./hosts/persistence.js";

describe("session ID storage/wire boundary", () => {
  test("keeps persisted plain strings, including legacy empty IDs, on the wire", () => {
    const serverId = "test-server";
    persistNamespacedScalar("lastSession", serverId, "legacy-session");
    const persisted = loadNamespacedScalar("lastSession", serverId);
    expect(persisted).toBe("legacy-session");

    const message: ClientMessage = {
      type: "prompt",
      text: "hello",
      sessionId: sessionId(persisted ?? ""),
    };
    const parsed = parseClientMessage(JSON.stringify(message));

    expect(JSON.parse(JSON.stringify(message))).toEqual({
      type: "prompt",
      text: "hello",
      sessionId: "legacy-session",
    });
    expect(parsed).toMatchObject({ type: "prompt", sessionId: "legacy-session" });

    persistNamespacedScalar("lastSession", serverId, "");
    const emptyMessage: ClientMessage = {
      type: "prompt",
      text: "empty-id",
      sessionId: sessionId(loadNamespacedScalar("lastSession", serverId) ?? ""),
    };
    expect(JSON.parse(JSON.stringify(emptyMessage))).toEqual({
      type: "prompt",
      text: "empty-id",
      sessionId: "",
    });
    expect(parseClientMessage(JSON.stringify(emptyMessage))).toMatchObject({
      type: "prompt",
      sessionId: "",
    });
  });
});
