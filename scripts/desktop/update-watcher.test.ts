import { describe, expect, test } from "bun:test";
import {
  decideAction,
  hasClientsFromHealth,
  isBuildStale,
  isBusyFromHealth,
  lockfileChanged,
  parseServerPid,
  shouldNotify,
} from "./update-watcher.js";

describe("decideAction", () => {
  const act = (behind: boolean, clientsConnected: boolean, busy: boolean) =>
    decideAction({ behind, clientsConnected, busy });

  test("up to date → noop regardless of host state", () => {
    expect(act(false, false, false)).toBe("noop");
    expect(act(false, true, true)).toBe("noop");
  });
  test("behind, unattended & idle (no client, not busy) → apply", () => {
    expect(act(true, false, false)).toBe("apply");
  });
  test("behind + client connected → defer (don't restart under a viewer)", () => {
    expect(act(true, true, false)).toBe("defer");
    expect(act(true, true, true)).toBe("defer");
  });
  test("behind + background turn, no client (busy) → defer (don't abort it)", () => {
    expect(act(true, false, true)).toBe("defer");
  });
});

describe("isBuildStale", () => {
  test("built bundle matches origin/main → fresh", () => {
    expect(isBuildStale("abc123", "abc123")).toBe(false);
  });
  test("built bundle behind origin/main → stale (the manual-pull / failed-build trap)", () => {
    expect(isBuildStale("old456", "new789")).toBe(true);
  });
  test("no build stamped yet (fresh clone) → stale, so the first tick builds it", () => {
    expect(isBuildStale(null, "abc123")).toBe(true);
  });
});

describe("lockfileChanged", () => {
  test("identical content → no change", () => {
    expect(lockfileChanged("abc", "abc")).toBe(false);
  });
  test("different content → change", () => {
    expect(lockfileChanged("abc", "xyz")).toBe(true);
  });
  test("appearance / disappearance counts as a change", () => {
    expect(lockfileChanged(null, "abc")).toBe(true);
    expect(lockfileChanged("abc", null)).toBe(true);
  });
  test("both absent → no change", () => {
    expect(lockfileChanged(null, null)).toBe(false);
  });
});

describe("isBusyFromHealth", () => {
  test("explicit busy flag wins", () => {
    expect(isBusyFromHealth({ busy: true })).toBe(true);
    expect(isBusyFromHealth({ busy: false, running: 5 })).toBe(false);
  });
  test("falls back to running + initializing counts", () => {
    expect(isBusyFromHealth({ running: 1, initializing: 0 })).toBe(true);
    expect(isBusyFromHealth({ running: 0, initializing: 2 })).toBe(true);
    expect(isBusyFromHealth({ running: 0, initializing: 0 })).toBe(false);
  });
  test("no activity fields → not busy", () => {
    expect(isBusyFromHealth({ ok: true, clients: 3 })).toBe(false);
  });
  test("malformed bodies → not busy (a missing signal must not block updates)", () => {
    expect(isBusyFromHealth(null)).toBe(false);
    expect(isBusyFromHealth("nope")).toBe(false);
    expect(isBusyFromHealth(undefined)).toBe(false);
  });
});

describe("hasClientsFromHealth", () => {
  test("positive client count → connected", () => {
    expect(hasClientsFromHealth({ clients: 1 })).toBe(true);
    expect(hasClientsFromHealth({ clients: 3, busy: false })).toBe(true);
  });
  test("zero / missing / malformed → not connected", () => {
    expect(hasClientsFromHealth({ clients: 0 })).toBe(false);
    expect(hasClientsFromHealth({ ok: true })).toBe(false);
    expect(hasClientsFromHealth(null)).toBe(false);
    expect(hasClientsFromHealth("nope")).toBe(false);
  });
});

describe("shouldNotify", () => {
  test("first sighting of a target → notify", () => {
    expect(shouldNotify("sha1", null)).toBe(true);
  });
  test("same target already notified → suppress", () => {
    expect(shouldNotify("sha1", "sha1")).toBe(false);
  });
  test("origin/main moved again → re-notify", () => {
    expect(shouldNotify("sha2", "sha1")).toBe(true);
  });
  test("no target → never notify", () => {
    expect(shouldNotify(null, "sha1")).toBe(false);
    expect(shouldNotify(null, null)).toBe(false);
  });
});

describe("parseServerPid", () => {
  test("JSON record from the pidlock", () => {
    expect(parseServerPid('{"pid":4321,"serverId":"abc"}')).toBe(4321);
  });
  test("bare int from run.sh before exec", () => {
    expect(parseServerPid("12345\n")).toBe(12345);
  });
  test("garbage / empty / non-positive → null", () => {
    expect(parseServerPid("")).toBeNull();
    expect(parseServerPid("   ")).toBeNull();
    expect(parseServerPid("not-a-pid")).toBeNull();
    expect(parseServerPid('{"pid":0}')).toBeNull();
    expect(parseServerPid('{"pid":-3}')).toBeNull();
    expect(parseServerPid('{"serverId":"x"}')).toBeNull();
  });
});
