// serveStatic serves the built client (client/dist). Untested — the valuable + security-
// critical part is the path-traversal defusal (normalize + leading/`..` strip) and the
// SPA fallback to index.html. A regression in the traversal guard would let
// ../../etc/passwd leak arbitrary files; a broken fallback would 404 client-side routes.
// config.clientDist is the singleton mutate-and-restore seam (same as config.token in
// config.test.ts); we point it at a tmpdir with a fake index.html + asset.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { serveStatic } from "./static.js";

describe("serveStatic", () => {
  let dir: string;
  const origClientDist = config.clientDist;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pilot-static-"));
    config.clientDist = dir;
    writeFileSync(join(dir, "index.html"), "<!doctype html>spa");
    writeFileSync(join(dir, "app.js"), "console.log('app');");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    config.clientDist = origClientDist;
  });

  test("serves an existing asset by pathname", async () => {
    const res = await serveStatic("/app.js");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("console.log('app');");
  });

  test("falls back to index.html for a client-side route (SPA)", async () => {
    // A path with no matching file (a /sessions/abc route) must serve index.html so the
    // client router takes over — not a 404.
    const res = await serveStatic("/sessions/abc");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("<!doctype html>spa");
  });

  test("returns null when no build is present (dev — caller returns a hint)", async () => {
    // Point at an empty dir: neither the asset nor index.html exists.
    const empty = mkdtempSync(join(tmpdir(), "pilot-static-empty-"));
    try {
      config.clientDist = empty;
      expect(await serveStatic("/anything")).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("falls back to index.html for a traversal-shaped path (no leak, no crash)", async () => {
    // serveStatic only ever sees URL pathnames (leading /). For that input shape, the
    // leading slash + normalize + join already keep the resolved path under clientDist
    // — the explicit ../ strip is defense-in-depth with no observable difference for
    // real inputs (verified: no pathname shape leaks differently with/without it). So we
    // pin the observable behavior: a traversal-shaped path neither leaks nor crashes,
    // it falls back to index.html. (If the strip were ever removed AND a caller passed a
    // non-URL relative path, this still wouldn't catch it — that gap is accepted; the
    // guard stays as belt-and-braces.)
    const res = await serveStatic("/../../etc/passwd");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("<!doctype html>spa");
  });

  test("a bare root path serves index.html", async () => {
    const res = await serveStatic("/");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("<!doctype html>spa");
  });
});
