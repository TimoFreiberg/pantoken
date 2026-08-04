import { describe, expect, test } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
} from "./wire.js";
import {
  sessionId,
  workspaceId,
  type SessionId,
  type SessionRef,
  type WorkspaceId,
} from "./session-driver.js";
import type { ClientMessage, ServerMessage } from "./wire.js";

const typedSession: SessionId = sessionId("session");
const typedWorkspace: WorkspaceId = workspaceId("workspace");
void typedSession;
void typedWorkspace;
// @ts-expect-error WorkspaceId is not a SessionId.
const wrongSession: SessionId = typedWorkspace;
// @ts-expect-error Plain strings must cross the session identity boundary explicitly.
const unbrandedSession: SessionId = "plain";
// @ts-expect-error Plain strings must cross the workspace identity boundary explicitly.
const unbrandedWorkspace: WorkspaceId = "plain";
void wrongSession;
void unbrandedSession;
void unbrandedWorkspace;

describe("wire parsing", () => {
  test("keeps protocol version and branded IDs as JSON strings", () => {
    expect(PROTOCOL_VERSION).toBe(6);
    const ref: SessionRef = { workspaceId: workspaceId("w"), sessionId: sessionId("s") };
    expect(JSON.parse(JSON.stringify(ref))).toEqual({ workspaceId: "w", sessionId: "s" });
    const parsed = parseServerMessage(JSON.stringify({
      type: "sessionList",
      sessions: [],
      activeSessionId: "s",
      defaultNewSessionCwd: "/home",
    }));
    expect(parsed).toMatchObject({ activeSessionId: "s" });
  });

  test("validates nested messages and ignores additive unknown fields", () => {
    const parsed = parseClientMessage(JSON.stringify({
      type: "sessionAction",
      action: { kind: "setModel", modelId: "model", futureActionField: true },
      sessionId: "s",
      futureEnvelopeField: { additive: true },
    }));
    expect(parsed).toMatchObject({ type: "sessionAction", sessionId: "s" });

    const event = parseServerMessage(JSON.stringify({
      type: "event",
      epoch: 1,
      seq: 2,
      event: {
        type: "hostUiRequest",
        sessionRef: { workspaceId: "w", sessionId: "s" },
        timestamp: "now",
        request: { kind: "confirm", requestId: "r", title: "Confirm", message: "Proceed?" },
      },
      future: "ignored",
    }));
    expect(event).not.toBeNull();
  });

  test("normalizes serde-defaulted server fields", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "hello", protocolVersion: 6, serverId: "server", dataDir: "/data",
    }))).toMatchObject({ serverLabel: "" });
    expect(parseServerMessage(JSON.stringify({ type: "fileIndex", files: [] }))).toMatchObject({ truncated: false });
  });

  test("accepts effective update/error contracts", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "updateStatus", available: false, applying: false,
      status: "rejected", reason: "failed", desktopStale: true,
    }))).not.toBeNull();
    for (const kind of ["session-switch", "abort", "sessionAction", "destroySession"]) {
      expect(parseServerMessage(JSON.stringify({ type: "error", message: "failed", kind }))).not.toBeNull();
    }
  });

  test("rejects unknown discriminants and malformed known fields", () => {
    for (const type of ["futureMessage", "constructor", "toString", "__proto__"]) {
      expect(parseClientMessage(JSON.stringify({ type }))).toBeNull();
      expect(parseServerMessage(JSON.stringify({ type }))).toBeNull();
    }
    expect(parseServerMessage(JSON.stringify({ type: "updateStatus", available: true, applying: false, reason: "nope" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "event", epoch: 1, seq: 1, event: {
      type: "assistantDelta", sessionRef: { workspaceId: "w", sessionId: 3 }, timestamp: "t", text: "x",
    } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "event", epoch: -1, seq: 1, event: {
      type: "sessionReset", sessionRef: { workspaceId: "w", sessionId: "s" }, timestamp: "t",
    } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "queryDir", requestId: -1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "respondUi", response: { requestId: "r", cancelled: false } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "dirListing", requestId: -1, path: "/", parent: null, entries: [] }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "pathStat", requestId: 1.5, path: "/", exists: true, isDir: true }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "hello", protocolVersion: 6, serverId: "s", dataDir: "/", buildSha: null }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "sessionStatus", runningIds: [], attention: null }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "queryDir", requestId: Number.MAX_SAFE_INTEGER + 2 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "prompt", text: "x", sessionId: null }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "setLoginShell" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "trustResponse", requestId: "r" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "sessionAction", action: { kind: "setModel" } }))).toBeNull();
    for (const kind of ["constructor", "toString", "__proto__"]) {
      expect(parseClientMessage(JSON.stringify({ type: "sessionAction", action: { kind } }))).toBeNull();
    }
    for (const type of ["constructor", "toString", "__proto__"]) {
      expect(parseServerMessage(JSON.stringify({ type: "event", epoch: 1, seq: 1, event: {
        type, sessionRef: { workspaceId: "w", sessionId: "s" }, timestamp: "t",
      } }))).toBeNull();
    }
    expect(parseServerMessage(JSON.stringify({ type: "event", epoch: 1, seq: 1, event: {
      type: "hostUiRequest", sessionRef: { workspaceId: "w", sessionId: "s" }, timestamp: "t",
      request: { kind: "constructor", requestId: "r" },
    } }))).toBeNull();
  });

  test("covers every top-level discriminant with a valid representative", () => {
    const clients: Record<ClientMessage["type"], unknown> = {
      hello: { type: "hello" }, prompt: { type: "prompt", text: "x" }, abort: { type: "abort" },
      restoreQueue: { type: "restoreQueue" }, respondUi: { type: "respondUi", response: { requestId: "r", cancelled: true } },
      sessionAction: { type: "sessionAction", action: { kind: "compact" } }, destroySession: { type: "destroySession", path: "/s" },
      setLoginShell: { type: "setLoginShell", path: null }, setBackgroundModel: { type: "setBackgroundModel", spec: null },
      openSession: { type: "openSession", path: "/s" }, reloadSession: { type: "reloadSession", path: "/s" },
      branch: { type: "branch", entryId: "e" }, newSession: { type: "newSession" }, listSessions: { type: "listSessions" },
      setArchived: { type: "setArchived", path: "/s", archived: false }, renameSession: { type: "renameSession", path: "/s", name: "n" },
      detachSession: { type: "detachSession", path: "/s" }, listCommands: { type: "listCommands" }, listFacets: { type: "listFacets" },
      fetchJobs: { type: "fetchJobs" }, deleteTodo: { type: "deleteTodo", id: 1 }, queryFiles: { type: "queryFiles", query: "x" },
      queryDir: { type: "queryDir", requestId: 1 }, statPath: { type: "statPath", path: "/s", requestId: 1 },
      trustResponse: { type: "trustResponse", requestId: "r", choice: null }, applyUpdate: { type: "applyUpdate" }, forceUpdate: { type: "forceUpdate" },
      requestSeed: { type: "requestSeed" }, mock: { type: "mock", script: "idle" }, openDataDir: { type: "openDataDir" }, ping: { type: "ping" },
    };
    for (const message of Object.values(clients)) expect(parseClientMessage(JSON.stringify(message))).not.toBeNull();

    const servers: Record<ServerMessage["type"], unknown> = {
      hello: { type: "hello", protocolVersion: 6, serverId: "s", dataDir: "/d" }, pong: { type: "pong" },
      seed: { type: "seed", sessionId: null, epoch: 1, seq: 0, events: [] }, event: { type: "event", epoch: 1, seq: 1, event: { type: "sessionReset", sessionRef: { workspaceId: "w", sessionId: "s" }, timestamp: "t" } },
      sessionList: { type: "sessionList", sessions: [], activeSessionId: null, defaultNewSessionCwd: "/" }, sessionStatus: { type: "sessionStatus", runningIds: [] },
      modelList: { type: "modelList", models: [] }, commandList: { type: "commandList", commands: [] }, facetList: { type: "facetList", facets: [] }, jobsList: { type: "jobsList", jobs: [] },
      fileIndex: { type: "fileIndex", files: [] }, fileList: { type: "fileList", query: "x", files: [] }, atRefs: { type: "atRefs", skills: [], subagents: [] },
      dirListing: { type: "dirListing", requestId: 1, path: "/", parent: null, entries: [] }, pathStat: { type: "pathStat", requestId: 1, path: "/", exists: true, isDir: true },
      modelDefaults: { type: "modelDefaults", defaults: { favorites: [] } }, pantokenSettings: { type: "pantokenSettings", settings: { loginShell: null, backgroundModel: null }, env: { activeShell: null, ok: false }, pendingRestart: false },
      trustRequest: { type: "trustRequest", requestId: "r", cwd: "/", title: "Trust", options: [] }, trustResolved: { type: "trustResolved", requestId: "r" },
      updateStatus: { type: "updateStatus", available: false, applying: false }, editorPrefill: { type: "editorPrefill", text: "x" }, promptResult: { type: "promptResult", promptId: "p", accepted: true },
      queueRestored: { type: "queueRestored", steering: [], followUp: [] }, abortResult: { type: "abortResult", accepted: true }, error: { type: "error", message: "x" },
    };
    for (const message of Object.values(servers)) expect(parseServerMessage(JSON.stringify(message))).not.toBeNull();
  });

  test("rejects malformed JSON and non-object frames", () => {
    for (const raw of ["", "not json", "null", "[]", "{\"type\":42}"]) {
      expect(parseClientMessage(raw)).toBeNull();
      expect(parseServerMessage(raw)).toBeNull();
    }
  });
});
