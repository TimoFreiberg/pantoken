// resolveWsUrl is the pure core of buildWsUrl. Split out so the `?ws=` loopback
// override + the env-override + default derivation are unit-testable without a
// DOM. The security-critical invariant: a `?ws=` param pointing off-loopback
// (e.g. ws://attacker.com/ws) MUST be rejected — it would exfiltrate the
// entire protocol stream including auth tokens (getToken()) and prompt
// content.

import { describe, expect, test } from "bun:test";
import { resolveWsUrl } from "./ws-url.js";

describe("resolveWsUrl (pure)", () => {
  test("env override wins over everything", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://127.0.0.1:9999/ws" };
    expect(resolveWsUrl(loc, "ws://override:1234")).toBe("ws://override:1234");
  });

  test("?ws= loopback override is accepted", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://127.0.0.1:9999/ws" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:9999/ws");
  });

  test("?ws= localhost override is accepted", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://localhost:9999/ws" };
    expect(resolveWsUrl(loc)).toBe("ws://localhost:9999/ws");
  });

  test("?ws= off-loopback is REJECTED → falls back to default (security)", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://attacker.com/ws" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("?ws= off-loopback with same hostname-as-path is rejected", () => {
    // A URL like ws://evil.example/127.0.0.1 must NOT trick the check — the
    // hostname is evil.example, not loopback.
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=ws://evil.example/127.0.0.1" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("?ws= not-a-url is rejected → default", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=not-a-url" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("no ?ws= → default derivation (http → ws)", () => {
    const loc = { protocol: "http:", host: "app.example:8787", search: "" };
    expect(resolveWsUrl(loc)).toBe("ws://app.example:8787/ws");
  });

  test("no ?ws= → default derivation (https → wss)", () => {
    const loc = { protocol: "https:", host: "app.example:8787", search: "" };
    expect(resolveWsUrl(loc)).toBe("wss://app.example:8787/ws");
  });

  test("empty ?ws= → default derivation", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?ws=" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:8787/ws");
  });

  test("other query params present → ?ws= still read", () => {
    const loc = { protocol: "http:", host: "127.0.0.1:8787", search: "?foo=bar&ws=ws://127.0.0.1:9999/ws&baz=1" };
    expect(resolveWsUrl(loc)).toBe("ws://127.0.0.1:9999/ws");
  });
});
