// urlBase64ToUint8Array decodes a VAPID public key (base64url) into the BufferSource
// PushManager.subscribe wants for applicationServerKey. Pure (only atob, available
// under bun test). Extracted as an export so the decode is testable without a DOM /
// PushManager. A regression (wrong padding, wrong -/_ char mapping, off-by-one in the
// byte copy) would silently produce a malformed key and break push subscription.

import { describe, expect, test } from "bun:test";
import { urlBase64ToUint8Array } from "./push.js";

// A known VAPID-shaped key (base64url, 65 bytes once decoded — the uncompressed
// P-256 public key length). Generated as a throwaway; only its decode-round-trip
// matters here, not its cryptographic validity.
const KEY_B64URL =
  "BHfJ7kBVUqy1QbXhV0l6tUvK8bMk3aZ9T2Jw0i5g2uE4yTf6r9p1qMs7nA3c8d2x5y8z0w4v6t1r";

function decodeStd(b64url: string): Uint8Array {
  // Reference decode: pad to a multiple of 4, map base64url → base64, atob.
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("urlBase64ToUint8Array", () => {
  test("round-trips a base64url key to the same bytes as a reference decode", () => {
    const got = urlBase64ToUint8Array(KEY_B64URL);
    const want = decodeStd(KEY_B64URL);
    expect(got).toEqual(want);
    expect(got.length).toBe(want.length);
  });

  test("returns a Uint8Array backed by an ArrayBuffer (not a generic view)", () => {
    // PushManager.subscribe rejects ArrayBufferLike that isn't ArrayBuffer-backed.
    // The impl allocates an explicit ArrayBuffer for exactly this reason.
    const got = urlBase64ToUint8Array(KEY_B64URL);
    expect(got.buffer).toBeInstanceOf(ArrayBuffer);
    expect(got.byteOffset).toBe(0);
    expect(got.buffer.byteLength).toBe(got.length);
  });

  test("handles a base64url string containing - and _ (not + and /)", () => {
    // base64url uses - and _ where standard base64 uses + and /. A key that happens to
    // contain those chars must map them correctly or the decode diverges.
    const withUrlChars = "AA-B_C";
    const got = urlBase64ToUint8Array(withUrlChars);
    const want = decodeStd(withUrlChars);
    expect(got).toEqual(want);
  });

  test("adds the padding a base64url string omits (length not a multiple of 4)", () => {
    // VAPID keys are usually already a multiple of 4, but the decode must handle the
    // general case: a string with length % 4 != 0 needs '=' padding before atob.
    const noPad = "YWJj"; // 'abc' base64, length 4 (no padding needed)
    const needsPad = "YWJ"; // length 3 → needs 1 pad char
    expect(urlBase64ToUint8Array(noPad)).toEqual(decodeStd(noPad));
    expect(urlBase64ToUint8Array(needsPad)).toEqual(decodeStd(needsPad));
    // The decoded content of 'YWJ' padded is 'ab' (base64 decodes 3 chars → 2 bytes).
    expect(Array.from(urlBase64ToUint8Array(needsPad))).toEqual([0x61, 0x62]);
  });

  test("decodes the full key with no byte dropped or duplicated", () => {
    // Off-by-one in the copy loop would drop/duplicate a trailing byte. Compare the
    // full byte sequence against the reference, not just the length.
    const got = Array.from(urlBase64ToUint8Array(KEY_B64URL));
    const want = Array.from(decodeStd(KEY_B64URL));
    expect(got).toEqual(want);
  });
});
