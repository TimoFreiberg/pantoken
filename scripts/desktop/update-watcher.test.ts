import { describe, expect, test } from "bun:test";
import {
  decideAction,
  isBusyFromHealth,
  lockfileChanged,
  parseServerPid,
  shouldNotify,
} from "./update-watcher.js";

describe("decideAction", () => {
  test("up to date → noop regardless of busy", () => {
    expect(decideAction({ behind: false, busy: false })).toBe("noop");
    expect(decideAction({ behind: false, busy: true })).toBe("noop");
  });
  test("behind + idle → apply", () => {
    expect(decideAction({ behind: true, busy: false })).toBe("apply");
  });
  test("behind + busy → defer (never interrupt a turn)", () => {
    expect(decideAction({ behind: true, busy: true })).toBe("defer");
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
