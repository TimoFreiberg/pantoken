# ece RustCrypto feasibility spike

**Date:** 2026-07-29  
**Scope:** Cargo-only feasibility for issue #119; no Buck2 graph regeneration or integration.

## Decision

**Promising but incomplete.** A local `ece 2.3.1` fork can preserve the published
`web-push 0.11.0` and `pantoken-server` APIs while replacing the default OpenSSL
backend with RustCrypto. The Cargo path compiles, the fixed upstream RFC 8291
vector passes, and the focused push/VAPID tests pass. Adoption is not yet a
production cryptography recommendation: the forked backend remains unreviewed,
there is no independent implementation/verifier beyond the fixed RFC oracle, and
HTTP wire capture plus Buck2 validation remain follow-up work.

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
- No OpenSSL appears in the ece/web-push subtree. The selected server closure still has unrelated `ring` through the existing `superboring`/JWT path; it is not introduced by this fork.
- `cargo test --locked -p web-push` is not runnable directly because the vendored web-push package is not a workspace member. Consumer compilation and server tests exercise its unchanged API instead.

## Gaps and risks

1. `ece` upstream is not security-reviewed, and this fork adds security-sensitive
   adapter code. A dedicated cryptographic review and dependency audit are required.
2. The RFC fixture is an independent protocol oracle, but the spike did not add a
   separately maintained decryptor or offline RFC 8292 VAPID signature verifier.
   Same-codec round trips are supplemental only.
3. No deterministic HTTP request-capture seam was added; exact provider wire
   assertions are follow-up work.
4. The full Cargo closure was not claimed native-free: unrelated baseline `ring`
   remains elsewhere in the server graph. Buck2/Reindeer generated graph and
   sandbox validation were intentionally not changed in this spike.
5. The global holder is process-wide and one-shot. Tests requiring alternate
   backends must run in separate processes/features.

## Recommendation

Treat this as a **promising feasibility result**, not production adoption. Before
merging into the main issue, perform independent cryptographic review, add an
independent decrypt/verify path and deterministic HTTP-wire tests, audit the full
native closure, then run a separately reviewed Reindeer/Buck2 closure experiment.
Keep the local patch and fork reversible until those gates pass.
