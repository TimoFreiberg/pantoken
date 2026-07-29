# ece RustCrypto feasibility spike

**Date:** 2026-07-29  
**Scope:** Cargo-only feasibility for issue #119; no Buck2 graph regeneration or integration.

## Decision

**Adopted (Issue #119).** A local `ece 2.3.1` fork preserves the published
`web-push 0.11.0` and `pantoken-server` APIs while replacing the default OpenSSL
backend with RustCrypto. The Cargo path compiles, the fixed upstream RFC 8291
vector passes, and the focused push/VAPID tests pass. The `web-push`
`hyper-client` feature was dropped in favor of an in-tree `ReqwestWebPushClient`
over the existing reqwest (rustls) client — no `web-push` fork needed. The ece
fork itself remains unreviewed cryptographic adapter code (see Gaps #1); the
HTTP-wire seam is now covered by adapter tests (Gap #3 closed).

## Implementation

- Fork: `third-party/vendor/ece-2.3.1-rustcrypto/`, preserving package name/version,
  MPL-2.0 provenance, and the existing public API.
- Backend: `p256` ECDH and SEC1 key parsing/serialization, `hkdf` + `sha2` for
  HKDF-SHA256, `aes-gcm` for AES-128-GCM, and `getrandom` for OS randomness.
- Features: new default `backend-rustcrypto`; `backend-openssl` remains optional
  and is not selected by the server path.
- Initialization: `ece::crypto::init_rustcrypto()` installs the process-wide
  holder exactly once. `pantoken-server` calls it before serve-mode dispatch;
  test-only ece initialization supports upstream vectors without changing the
  production contract. A second installation returns the existing one-shot error.
- Wiring: reversible `[patch.crates-io]` entries exist in root `Cargo.toml` and
  standalone `third-party/Cargo.toml`; both lockfiles record the local fork.
  `web-push` and `push.rs` were not rewritten.

## Evidence

Baseline before the patch:

- `cargo tree --locked -p pantoken-server -i ece`: `ece 2.3.1 → web-push 0.11.0 → pantoken-server`.
- `cargo tree --locked -p pantoken-server -i openssl`: OpenSSL was selected through ece.
- Focused baseline push tests: 19 passed.

Patched commands and results:

- `cargo fmt --all -- --check`: passed.
- `cargo check --locked -p pantoken-server`: passed.
- `env -u OPENSSL_DIR -u OPENSSL_INCLUDE_DIR -u OPENSSL_LIB_DIR cargo test --locked -p pantoken-server push::tests --no-fail-fast`: 19 passed.
- `cargo test --manifest-path third-party/vendor/ece-2.3.1-rustcrypto/Cargo.toml --locked --offline --no-default-features --features backend-rustcrypto,backend-test-helper`: 25 passed, including exact RFC 8291 ciphertext, decryption, record-size, padding, key-validation, and invalid-input cases.
- `cargo metadata --locked --manifest-path third-party/Cargo.toml`: passed; standalone Reindeer closure resolves the fork.
- `cargo tree --locked -p pantoken-server -i ece`: resolves to the local fork.
- No OpenSSL appears in the ece/web-push subtree. `ring` enters via `reqwest[rustls-tls]` → `rustls` (not `superboring` — superboring is pure RustCrypto used by `jwt-simple`); it is not introduced by this fork.
- `cargo test --locked -p web-push` is not runnable directly because the vendored web-push package is not a workspace member. Consumer compilation and server tests exercise its unchanged API instead.

## Gaps and risks

1. `ece` upstream is not security-reviewed, and this fork adds security-sensitive
   adapter code. A dedicated cryptographic review and dependency audit are required.
2. The RFC fixture is an independent protocol oracle, but the spike did not add a
   separately maintained decryptor or offline RFC 8292 VAPID signature verifier.
   Same-codec round trips are supplemental only.
3. ~~No deterministic HTTP request-capture seam was added; exact provider wire
   assertions are follow-up work.~~ **Resolved (Issue #119):** Adapter tests
   (`adapter_sends_well_formed_request`, `adapter_classifies_dead_endpoints`,
   `adapter_propagates_retry_after`, `adapter_caps_response_size`) now cover the
   HTTP wire seam against a local axum server.
4. The full Cargo closure was not claimed native-free: unrelated baseline `ring`
   remains elsewhere in the server graph. Buck2/Reindeer generated graph and
   sandbox validation were intentionally not changed in this spike.
5. The global holder is process-wide and one-shot. Tests requiring alternate
   backends must run in separate processes/features.

## Recommendation

**Adopted.** The fork is integrated on main (Issue #119). The ece RustCrypto
backend remains flagged for a dedicated cryptographic review (Gap #1). The
Reindeer/Buck2 closure has been regenerated and validated — `pantoken-server`
builds and all test targets pass under Buck2.
