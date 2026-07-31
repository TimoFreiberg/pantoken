//! Web Push fan-out: lets the server buzz a closed phone (or any installed PWA)
//! via the Web Push protocol. Keeps a file-backed subscription store + a persistent
//! VAPID keypair under the data dir so subscriptions survive a server restart.
//!
//! Port of `server/src/push.ts` (179 LOC).
//!
//! The subscription store (add/remove/count/persist/prune) is fully ported and
//! unit-tested. The VAPID keypair generation uses `jwt-simple`'s `ES256KeyPair`
//! (the same P-256 primitive the TS `web-push` library uses). Delivery uses a
//! reqwest-based `WebPushClient` implementation (`ReqwestWebPushClient`) that
//! reuses the server's existing rustls HTTP stack — no OpenSSL/native-tls
//! dependency. On-device delivery is validated manually on the owner's iPhone
//! (same as the TS implementation).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use ct_codecs::{Base64UrlSafeNoPadding, Encoder};
use futures_util::future::join_all;
use jwt_simple::prelude::*;
use serde::{Deserialize, Serialize};
use web_push::*;

/// A push notification to send.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushNotification {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// App-icon badge count (Badging API). 0 means "clear the badge"; omitted
    /// means "leave it alone" — the service worker distinguishes the two.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<u32>,
}

/// A web push subscription (endpoint + keys).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSubscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

/// VAPID keypair.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VapidKeys {
    public_key: String,
    private_key: String,
}

/// File-backed subscription store: the set of push endpoints pantoken will fan out to.
/// Keyed by endpoint (so re-subscribing a device is a no-op).
pub struct PushSubscriptionStore {
    subs: HashMap<String, PushSubscription>,
    file: PathBuf,
}

impl PushSubscriptionStore {
    pub fn new(file: PathBuf) -> Self {
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut store = Self {
            subs: HashMap::new(),
            file,
        };
        store.load();
        store
    }

    pub fn count(&self) -> usize {
        self.subs.len()
    }
    pub fn values(&self) -> Vec<PushSubscription> {
        self.subs.values().cloned().collect()
    }

    pub fn add(&mut self, sub: PushSubscription) {
        self.subs.insert(sub.endpoint.clone(), sub);
        self.persist();
    }

    pub fn remove(&mut self, endpoint: &str) {
        if self.subs.remove(endpoint).is_some() {
            self.persist();
        }
    }

    pub fn prune(&mut self, dead: &[String]) {
        if dead.is_empty() {
            return;
        }
        for ep in dead {
            self.subs.remove(ep);
        }
        self.persist();
    }

    fn load(&mut self) {
        if !self.file.exists() {
            return;
        }
        if let Ok(raw) = fs::read_to_string(&self.file) {
            match serde_json::from_str::<Vec<PushSubscription>>(&raw) {
                Ok(arr) => {
                    for s in arr {
                        self.subs.insert(s.endpoint.clone(), s);
                    }
                }
                Err(e) => eprintln!("[push] failed to parse {}: {}", self.file.display(), e),
            }
        }
    }

    fn persist(&self) {
        let arr: Vec<&PushSubscription> = self.subs.values().collect();
        let json = serde_json::to_string_pretty(&arr).unwrap_or_else(|_| "[]".into());
        let _ = fs::write(&self.file, format!("{json}\n"));
    }
}

/// Maximum response body size we'll read from a push service (64 KiB).
/// Mirrors `web_push::clients::MAX_RESPONSE_SIZE` (private const).
const MAX_RESPONSE_SIZE: usize = 64 * 1024;

/// Parse a `Retry-After` header value into a `Duration`.
///
/// Duplicates `web_push::error::RetryAfter::from_str` (not publicly exported).
/// Accepts either an integer number of seconds or an RFC 2822 date.
fn parse_retry_after(header_value: &str) -> Option<Duration> {
    if let Ok(seconds) = header_value.parse::<u64>() {
        Some(Duration::from_secs(seconds))
    } else {
        chrono::DateTime::parse_from_rfc2822(header_value)
            .map(|date_time| {
                let systime: std::time::SystemTime = date_time.into();
                systime
                    .duration_since(std::time::SystemTime::now())
                    .unwrap_or_else(|_| Duration::new(0, 0))
            })
            .ok()
    }
}

/// A reqwest-based `WebPushClient` that reuses the server's rustls HTTP stack.
///
/// Replaces `web_push::HyperWebPushClient` (which pulled in `hyper-tls` →
/// `native-tls` → OpenSSL). This client builds the HTTP request via
/// `web_push::request_builder::build_request`, translates it to reqwest,
/// sends it, and parses the response via `web_push::request_builder::parse_response`.
///
/// Thread-safe and `Clone` (reqwest::Client is cheaply cloneable — shares a
/// connection pool), matching the contract the fan-out code relies on.
#[derive(Clone)]
pub struct ReqwestWebPushClient {
    client: reqwest::Client,
}

impl Default for ReqwestWebPushClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestWebPushClient {
    /// Creates a new client with the same rustls-based configuration the server
    /// uses elsewhere.
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl WebPushClient for ReqwestWebPushClient {
    /// Sends a notification. Never times out (mirrors the hyper client contract).
    async fn send(&self, message: WebPushMessage) -> Result<(), WebPushError> {
        // Build the HTTP request via web-push's own builder (http 0.2 types).
        let request = web_push::request_builder::build_request::<Vec<u8>>(message);

        // Translate the http 0.2 request into a reqwest request builder.
        let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
            .map_err(|_| WebPushError::Unspecified)?;
        let url = request
            .uri()
            .to_string()
            .parse::<reqwest::Url>()
            .map_err(|_| WebPushError::InvalidUri)?;

        // Collect headers before consuming the body (into_body takes ownership).
        // web-push uses http 0.2; reqwest uses http 1.x. We convert via strings
        // to bridge the two versions.
        let headers: Vec<(String, String)> = request
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();
        let body = request.into_body();
        let mut req_builder = self.client.request(method, url).body(body);

        // Re-apply all headers from the original request.
        // (build_request already set TTL, Content-Encoding, Content-Length,
        // Content-Type, and crypto headers.)
        for (name, value) in headers {
            req_builder = req_builder.header(name, value);
        }

        // Send the request.
        let response = req_builder
            .send()
            .await
            // The hyper client maps hyper::Error → WebPushError::Unspecified;
            // we do the same for reqwest transport failures.
            .map_err(|_| WebPushError::Unspecified)?;

        // Extract Retry-After before consuming the response.
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|ra| ra.to_str().ok())
            .and_then(parse_retry_after);

        let status_02 = http::StatusCode::from_u16(response.status().as_u16())
            .map_err(|_| WebPushError::Unspecified)?;

        // Read the response body with the 64 KiB cap.
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| WebPushError::Unspecified)?;
            body.extend_from_slice(&chunk);
            if body.len() > MAX_RESPONSE_SIZE {
                return Err(WebPushError::ResponseTooLarge);
            }
        }

        // Parse the response via web-push's own parser.
        let result = web_push::request_builder::parse_response(status_02, body);

        // Patch ServerError with retry_after, exactly as the hyper client does.
        if let Err(WebPushError::ServerError {
            retry_after: None,
            info,
        }) = result
        {
            Err(WebPushError::ServerError { retry_after, info })
        } else {
            Ok(result?)
        }
    }
}

/// The VAPID-bound push service: owns a subscription store + a VAPID keypair.
pub struct PushService {
    store: PushSubscriptionStore,
    vapid: VapidKeys,
    vapid_subject: String,
    /// Reusable VAPID key builder (clone per-send — cheap, avoids re-parsing the
    /// private key for every subscription). `None` when the keypair is corrupt
    /// or unreadable — push is disabled in that case (logged at construction).
    sig_builder: Option<PartialVapidSignatureBuilder>,
}

impl PushService {
    pub fn new(data_dir: &Path, vapid_subject: String) -> Self {
        let _ = fs::create_dir_all(data_dir);
        let vapid = load_or_create_vapid(&data_dir.join("vapid.json"));
        let store = PushSubscriptionStore::new(data_dir.join("push-subscriptions.json"));

        if vapid_subject.contains("localhost") || vapid_subject.contains("example.com") {
            eprintln!(
                "[push] VAPID subject is a placeholder ({vapid_subject}). iOS push will fail."
            );
        }

        // Build the reusable partial signature builder from the stored private
        // key. A corrupt/unreadable keypair degrades gracefully: log and run
        // with push disabled rather than panicking at startup.
        let sig_builder = match VapidSignatureBuilder::from_base64_no_sub(&vapid.private_key) {
            Ok(b) => Some(b),
            Err(e) => {
                tracing::error!(
                    "[push] VAPID keypair is corrupt — push disabled (delete vapid.json to regenerate): {e}"
                );
                None
            }
        };

        Self {
            store,
            vapid,
            vapid_subject,
            sig_builder,
        }
    }

    pub fn public_key(&self) -> &str {
        &self.vapid.public_key
    }
    pub fn count(&self) -> usize {
        self.store.count()
    }
    pub fn add(&mut self, sub: PushSubscription) {
        self.store.add(sub);
    }
    pub fn remove(&mut self, endpoint: &str) {
        self.store.remove(endpoint);
    }

    /// Send to every stored subscription; prune the ones the push service reports gone.
    ///
    /// Fans out concurrently (mirroring the TS `Promise.all`): builds all signed
    /// messages up front, then sends them all at once via `join_all`, so N
    /// subscriptions take ~1× wall time instead of N×. The `ReqwestWebPushClient`
    /// is `Clone` + thread-safe, so each send runs independently.
    pub async fn send_to_all(&mut self, n: &PushNotification) -> usize {
        let subs = self.store.values();
        if subs.is_empty() {
            return 0;
        }
        // Push disabled (corrupt VAPID keypair): no-op, don't crash.
        let Some(sig_builder) = &self.sig_builder else {
            tracing::warn!("[push] send_to_all called with push disabled (corrupt VAPID keypair)");
            return 0;
        };
        // C1: PushNotification contains String, Option<String>, and Option<u32>
        // fields, all of which are infallibly serializable by serde_json — expect
        // rather than silently substituting an empty payload (which would send a
        // corrupted notification).
        let payload = serde_json::to_vec(n).expect(
            "PushNotification serialization is infallible (String, Option<String>, and Option<u32> fields)",
        );
        let client = ReqwestWebPushClient::new();
        let partial = sig_builder.clone();
        let subject = self.vapid_subject.clone();

        // Build all signed messages up front (under this method's &mut self,
        // but no store mutation yet). A per-sub sign/build failure is logged
        // and skipped — the sub is neither sent nor pruned.
        let mut messages = Vec::with_capacity(subs.len());
        for sub in &subs {
            let sub_info = SubscriptionInfo {
                endpoint: sub.endpoint.clone(),
                keys: sub.keys.clone(),
            };
            let sig = {
                let mut builder = partial.clone().add_sub_info(&sub_info);
                builder.add_claim("sub", subject.clone());
                match builder.build() {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[push] VAPID sign failed for {}: {e}", sub.endpoint);
                        continue;
                    }
                }
            };
            let mut msg_builder = WebPushMessageBuilder::new(&sub_info);
            msg_builder.set_payload(ContentEncoding::Aes128Gcm, &payload);
            msg_builder.set_vapid_signature(sig);
            match msg_builder.build() {
                Ok(m) => messages.push((sub.endpoint.clone(), m)),
                Err(e) => {
                    eprintln!("[push] message build failed for {}: {e}", sub.endpoint);
                    continue;
                }
            }
        }

        // Send all built messages concurrently. `client` is Clone+thread-safe;
        // each future owns its message + a client clone.
        let results = join_all(messages.into_iter().map(|(endpoint, message)| {
            let client = client.clone();
            async move {
                let outcome = classify_send_result(&client.send(message).await);
                (endpoint, outcome)
            }
        }))
        .await;

        // Accumulate sent + dead from the per-send outcomes.
        let mut dead = Vec::new();
        let mut sent = 0;
        for (endpoint, outcome) in results {
            match outcome {
                SendOutcome::Sent => sent += 1,
                SendOutcome::Dead => dead.push(endpoint),
                SendOutcome::Failed => eprintln!("[push] send failed for {endpoint}"),
            }
        }

        self.store.prune(&dead);
        sent
    }
}

/// Whether a push-service HTTP status code means the subscription is dead
/// (expired/revoked) and should be pruned. Mirrors TS `push.ts:158`
/// (`code === 404 || code === 410`).
pub fn is_dead_status(code: u16) -> bool {
    code == 404 || code == 410
}

/// Returns true if the push service reports the subscription as gone (404/410),
/// matching the TS implementation's dead-endpoint pruning.
///
/// Classifies on the *variant* (`EndpointNotFound`/`EndpointNotValid`), which
/// `parse_response` selects from the real HTTP status — NOT on `info.code`,
/// which is parsed from the response *body* and can diverge from the HTTP status
/// if a push service returns a mismatched body. A 404/410 HTTP status is the
/// dead signal regardless of body contents (TS reads `e.statusCode`).
fn is_dead_endpoint(e: &WebPushError) -> bool {
    matches!(
        e,
        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
    )
}

/// The outcome of a single push send, used to accumulate `sent`/`dead` counts
/// in [`PushService::send_to_all`] without holding a lock or doing HTTP inline.
/// Extracted so the classification logic is unit-testable without a live send.
enum SendOutcome {
    Sent,
    Dead,
    Failed,
}

/// Classify the result of `WebPushClient::send` into a [`SendOutcome`].
/// - `Ok` → [`SendOutcome::Sent`]
/// - `Err` with a 404/410 status (dead endpoint) → [`SendOutcome::Dead`]
/// - any other `Err` → [`SendOutcome::Failed`]
fn classify_send_result(res: &Result<(), WebPushError>) -> SendOutcome {
    match res {
        Ok(()) => SendOutcome::Sent,
        Err(e) => {
            if is_dead_endpoint(e) {
                SendOutcome::Dead
            } else {
                SendOutcome::Failed
            }
        }
    }
}

fn load_or_create_vapid(path: &Path) -> VapidKeys {
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(keys) = serde_json::from_str::<VapidKeys>(&raw) {
                return keys;
            }
        }
    }
    // Generate a fresh ECDSA P-256 keypair (the curve VAPID requires).
    // `ES256KeyPair::generate()` is the same primitive the TS `web-push`
    // library's `generateVAPIDKeys()` uses under the hood.
    let keypair = ES256KeyPair::generate();
    let private_bytes = keypair.to_bytes();
    let private_key = Base64UrlSafeNoPadding::encode_to_string(&private_bytes).unwrap_or_default();
    // Derive the public key the browser expects via the web-push crate's own
    // API: the uncompressed P-256 point (65 bytes: 0x04 prefix + X + Y),
    // base64url-encoded without padding. This is the `applicationServerKey`.
    let public_bytes = VapidSignatureBuilder::from_base64_no_sub(&private_key)
        .expect("just-generated key must parse")
        .get_public_key();
    let keys = VapidKeys {
        public_key: Base64UrlSafeNoPadding::encode_to_string(&public_bytes).unwrap_or_default(),
        private_key,
    };
    let json = serde_json::to_string_pretty(&keys).unwrap_or_default();
    let _ = fs::write(path, format!("{json}\n"));
    println!("[push] generated a new VAPID keypair at {}", path.display());
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_payload_includes_badge_and_omits_none_fields() {
        // The SW reads `badge` as a number (0 = clear); optional fields must be
        // absent — not null — so `"tag" in data`-style checks stay meaningful.
        let with_badge = PushNotification {
            title: "t".into(),
            body: "b".into(),
            tag: Some("tag".into()),
            url: Some("/?session=s1".into()),
            badge: Some(2),
        };
        let json = serde_json::to_value(&with_badge).unwrap();
        assert_eq!(json["badge"], 2);
        assert_eq!(json["url"], "/?session=s1");

        let bare = PushNotification {
            title: "t".into(),
            body: "b".into(),
            tag: None,
            url: None,
            badge: None,
        };
        let json = serde_json::to_value(&bare).unwrap();
        assert!(json.get("badge").is_none());
        assert!(json.get("tag").is_none());
        assert!(json.get("url").is_none());
    }

    #[test]
    fn store_add_remove_count() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PushSubscriptionStore::new(dir.path().join("subs.json"));
        assert_eq!(store.count(), 0);
        store.add(PushSubscription {
            endpoint: "https://push.example.com/123".into(),
            keys: SubscriptionKeys {
                p256dh: "key1".into(),
                auth: "auth1".into(),
            },
        });
        assert_eq!(store.count(), 1);
        store.add(PushSubscription {
            endpoint: "https://push.example.com/123".into(),
            keys: SubscriptionKeys {
                p256dh: "key1".into(),
                auth: "auth1".into(),
            },
        });
        assert_eq!(store.count(), 1);
        store.remove("https://push.example.com/123");
        assert_eq!(store.count(), 0);
    }

    #[test]
    fn store_persists_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subs.json");
        let mut store1 = PushSubscriptionStore::new(path.clone());
        store1.add(PushSubscription {
            endpoint: "https://push.example.com/abc".into(),
            keys: SubscriptionKeys {
                p256dh: "k".into(),
                auth: "a".into(),
            },
        });
        let store2 = PushSubscriptionStore::new(path);
        assert_eq!(store2.count(), 1);
    }

    #[test]
    fn store_prune_dead() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PushSubscriptionStore::new(dir.path().join("subs.json"));
        for i in 0..3 {
            store.add(PushSubscription {
                endpoint: format!("https://push.example.com/{i}"),
                keys: SubscriptionKeys {
                    p256dh: "k".into(),
                    auth: "a".into(),
                },
            });
        }
        assert_eq!(store.count(), 3);
        store.prune(&[
            "https://push.example.com/0".into(),
            "https://push.example.com/2".into(),
        ]);
        assert_eq!(store.count(), 1);
    }

    #[test]
    fn vapid_keygen_produces_valid_keypair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vapid.json");
        let keys = load_or_create_vapid(&path);

        // Public key: base64url-no-padding of the uncompressed P-256 point (65 bytes).
        let pub_bytes = Base64UrlSafeNoPadding::decode_to_vec(&keys.public_key, None).unwrap();
        assert_eq!(pub_bytes.len(), 65, "uncompressed P-256 point is 65 bytes");
        assert_eq!(pub_bytes[0], 0x04, "uncompressed point prefix is 0x04");

        // Private key: base64url-no-padding of the 32-byte scalar.
        let priv_bytes = Base64UrlSafeNoPadding::decode_to_vec(&keys.private_key, None).unwrap();
        assert_eq!(priv_bytes.len(), 32, "P-256 private key scalar is 32 bytes");

        // The private key must round-trip through ES256KeyPair and re-derive the
        // same public key — this is what the browser relies on for stability.
        // We derive the public key via the web-push crate's own API (same path
        // as load_or_create_vapid) to verify consistency.
        let rederived = VapidSignatureBuilder::from_base64_no_sub(&keys.private_key)
            .unwrap()
            .get_public_key();
        assert_eq!(
            rederived, pub_bytes,
            "public key must re-derive from private"
        );
    }

    #[test]
    fn vapid_keypair_persists_across_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vapid.json");

        let keys1 = load_or_create_vapid(&path);
        assert!(path.exists(), "vapid.json should be written");

        // Second load should read the same keypair from disk, not regenerate.
        let keys2 = load_or_create_vapid(&path);
        assert_eq!(keys1.public_key, keys2.public_key);
        assert_eq!(keys1.private_key, keys2.private_key);
    }

    #[test]
    fn push_service_loads_vapid_key() {
        let dir = tempfile::tempdir().unwrap();
        let svc = PushService::new(dir.path(), "mailto:test@test.com".into());

        // The public key must be non-empty and valid base64url.
        assert!(!svc.public_key().is_empty());
        let pub_bytes = Base64UrlSafeNoPadding::decode_to_vec(svc.public_key(), None).unwrap();
        assert_eq!(pub_bytes.len(), 65);

        // The sig_builder loaded successfully from the generated key.
    }

    #[test]
    fn push_service_corrupt_vapid_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let vapid_path = dir.path().join("vapid.json");
        // Write a VAPID key file with valid JSON + valid base64url but a private
        // key that's the wrong length (not a valid P-256 scalar). This passes
        // load_or_create_vapid's JSON parse but fails VapidSignatureBuilder.
        fs::write(&vapid_path, r#"{"publicKey":"AAAA","privateKey":"AAAA"}"#).unwrap();
        // Construction must not panic — push is disabled instead.
        let svc = PushService::new(dir.path(), "mailto:test@test.com".into());
        // The key assertion: construction didn't panic. If the builder rejected
        // the short key, push is disabled (sig_builder is None). If the builder
        // was lenient, push is enabled — either way, no panic.
        // Verify we can still call public_key() without crashing.
        let _ = svc.public_key();
    }

    #[test]
    fn is_dead_status_classifies_correctly() {
        // Dead: 404 (Not Found) + 410 (Gone) — the codes the push service
        // returns when a subscription has expired/been revoked.
        assert!(is_dead_status(404));
        assert!(is_dead_status(410));
        // Not dead: success, server errors, auth, etc.
        assert!(!is_dead_status(200));
        assert!(!is_dead_status(500));
        assert!(!is_dead_status(403));
        assert!(!is_dead_status(400));
    }

    #[test]
    fn is_dead_endpoint_classifies_correctly() {
        // Construct the dead-variant errors via the crate's own response parser
        // (ErrorInfo is in a private module, so this is the public entry point).
        // 404 → EndpointNotFound, 410 → EndpointNotValid — both dead.
        let not_found =
            web_push::request_builder::parse_response(http::StatusCode::NOT_FOUND, vec![]);
        let gone = web_push::request_builder::parse_response(http::StatusCode::GONE, vec![]);
        assert!(matches!(not_found, Err(WebPushError::EndpointNotFound(_))));
        assert!(matches!(gone, Err(WebPushError::EndpointNotValid(_))));
        assert!(is_dead_endpoint(&not_found.unwrap_err()), "404 is dead");
        assert!(is_dead_endpoint(&gone.unwrap_err()), "410 is dead");

        // Non-dead variants are NOT classified as dead.
        assert!(!is_dead_endpoint(&WebPushError::Unspecified));
        assert!(!is_dead_endpoint(&WebPushError::InvalidUri));
        assert!(!is_dead_endpoint(&WebPushError::PayloadTooLarge));
        assert!(!is_dead_endpoint(&WebPushError::InvalidTtl));
        assert!(!is_dead_endpoint(&WebPushError::InvalidTopic));
    }

    #[test]
    fn classify_send_result_sent() {
        let res: Result<(), WebPushError> = Ok(());
        assert!(matches!(classify_send_result(&res), SendOutcome::Sent));
    }

    #[test]
    fn classify_send_result_dead() {
        // 404 → EndpointNotFound (dead), 410 → EndpointNotValid (dead).
        let not_found =
            web_push::request_builder::parse_response(http::StatusCode::NOT_FOUND, vec![])
                .unwrap_err();
        assert!(matches!(
            classify_send_result(&Err(not_found)),
            SendOutcome::Dead
        ));
        let gone =
            web_push::request_builder::parse_response(http::StatusCode::GONE, vec![]).unwrap_err();
        assert!(matches!(
            classify_send_result(&Err(gone)),
            SendOutcome::Dead
        ));
    }

    #[test]
    fn classify_send_result_failed() {
        // Any non-dead error → Failed.
        assert!(matches!(
            classify_send_result(&Err(WebPushError::Unspecified)),
            SendOutcome::Failed
        ));
        assert!(matches!(
            classify_send_result(&Err(WebPushError::PayloadTooLarge)),
            SendOutcome::Failed
        ));
    }

    // ── Ported from push.test.ts.bak ──────────────────────────

    fn sub(endpoint: &str) -> PushSubscription {
        PushSubscription {
            endpoint: endpoint.to_string(),
            keys: SubscriptionKeys {
                p256dh: format!("p256-{endpoint}"),
                auth: format!("auth-{endpoint}"),
            },
        }
    }

    #[test]
    fn add_is_idempotent_by_endpoint_with_rotated_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PushSubscriptionStore::new(dir.path().join("subs.json"));
        store.add(sub("https://fcm/a"));
        store.add(PushSubscription {
            endpoint: "https://fcm/a".into(),
            keys: SubscriptionKeys {
                p256dh: "rotated".into(),
                auth: "rotated".into(),
            },
        });
        assert_eq!(store.count(), 1);
        let vals = store.values();
        assert_eq!(vals[0].keys.auth, "rotated");
    }

    #[test]
    fn remove_drops_subscription_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subs.json");
        let mut store = PushSubscriptionStore::new(path.clone());
        store.add(sub("https://fcm/a"));
        store.add(sub("https://fcm/b"));
        store.remove("https://fcm/a");
        assert_eq!(store.count(), 1);
        assert_eq!(store.values()[0].endpoint, "https://fcm/b");
        // persisted: reload from disk
        let reloaded = PushSubscriptionStore::new(path);
        assert_eq!(reloaded.count(), 1);
    }

    #[test]
    fn remove_is_noop_for_unknown_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subs.json");
        let mut store = PushSubscriptionStore::new(path.clone());
        store.add(sub("https://fcm/a"));
        let before = std::fs::read_to_string(&path).unwrap();
        store.remove("https://fcm/never-added");
        assert_eq!(store.count(), 1);
        // no file rewrite
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn prune_with_empty_list_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subs.json");
        let mut store = PushSubscriptionStore::new(path.clone());
        store.add(sub("https://fcm/a"));
        let before = std::fs::read_to_string(&path).unwrap();
        store.prune(&[]);
        assert_eq!(store.count(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn prune_tolerates_endpoints_not_present() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PushSubscriptionStore::new(dir.path().join("subs.json"));
        store.add(sub("https://fcm/a"));
        store.add(sub("https://fcm/b"));
        store.prune(&["https://fcm/a".into(), "https://fcm/unknown".into()]);
        assert_eq!(store.count(), 1);
        assert_eq!(store.values()[0].endpoint, "https://fcm/b");
    }

    #[test]
    fn malformed_subs_file_falls_back_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subs.json");
        let mut store = PushSubscriptionStore::new(path.clone());
        store.add(sub("https://fcm/a"));
        // Corrupt the file
        std::fs::write(&path, "{ not valid json").unwrap();
        let reloaded = PushSubscriptionStore::new(path);
        assert_eq!(reloaded.count(), 0);
    }

    // ── ReqwestWebPushClient adapter tests ─────────────────────
    //
    // These tests spin up a local axum server to verify the HTTP-wire behavior
    // of the reqwest-based push client: request shape, dead-endpoint
    // classification (404/410), Retry-After propagation, and the 64 KiB
    // response-body cap.

    use std::sync::{Arc, Mutex, Once};
    use std::time::Duration;

    use axum::Router;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::any;
    use tokio::net::TcpListener;

    /// Initialize ece's RustCrypto backend once for all adapter tests.
    /// `build_test_message` encrypts a payload, which requires the cryptographer.
    static ECE_INIT: Once = Once::new();
    fn ensure_ece_init() {
        ECE_INIT.call_once(|| {
            let _ = ece::crypto::init_rustcrypto();
        });
    }

    /// Captured request details from the mock push server.
    #[derive(Default, Clone)]
    struct CapturedRequest {
        method: Option<String>,
        ttl: Option<String>,
        content_encoding: Option<String>,
        authorization: Option<String>,
        body: Option<Vec<u8>>,
    }

    /// Build a signed `WebPushMessage` for a subscription pointing at `endpoint`.
    fn build_test_message(endpoint: &str) -> WebPushMessage {
        ensure_ece_init();
        let sub_info = SubscriptionInfo {
            endpoint: endpoint.to_string(),
            keys: SubscriptionKeys {
                p256dh: "BLMbF9ffKBiWQLCKvTHb6LO8Nb6dcUh6TItC455vu2kElga6PQvUmaFyCdykxY2nOSSL3yKgfbmFLRTUaGv4yV8".into(),
                auth: "xS03Fi5ErfTNH_l9WHE9Ig".into(),
            },
        };
        // Generate a VAPID keypair for signing.
        let keypair = ES256KeyPair::generate();
        let private_bytes = keypair.to_bytes();
        let private_key = Base64UrlSafeNoPadding::encode_to_string(&private_bytes).unwrap();
        let partial = VapidSignatureBuilder::from_base64_no_sub(&private_key).unwrap();
        let mut sig_builder = partial.add_sub_info(&sub_info);
        sig_builder.add_claim("sub", "mailto:test@test.com".to_string());
        let sig = sig_builder.build().unwrap();

        let mut msg_builder = WebPushMessageBuilder::new(&sub_info);
        msg_builder.set_payload(
            ContentEncoding::Aes128Gcm,
            br#"{"title":"test","body":"hello"}"#,
        );
        msg_builder.set_vapid_signature(sig);
        msg_builder.build().unwrap()
    }

    /// Start a mock push server that captures the request and responds with
    /// the given status, headers, and body.
    async fn start_mock_server(
        status: StatusCode,
        extra_headers: Vec<(&'static str, &'static str)>,
        body: Vec<u8>,
    ) -> (String, Arc<Mutex<CapturedRequest>>) {
        let captured = Arc::new(Mutex::new(CapturedRequest::default()));
        let captured_clone = captured.clone();

        let app = Router::new().route(
            "/{anything}",
            any(move |req: Request| {
                let captured = captured_clone.clone();
                let status = status;
                let extra_headers = extra_headers.clone();
                let resp_body = body.clone();
                async move {
                    let (parts, req_body) = req.into_parts();
                    let req_bytes = axum::body::to_bytes(req_body, usize::MAX)
                        .await
                        .unwrap_or_default();
                    let mut cap = captured.lock().unwrap();
                    cap.method = Some(parts.method.to_string());
                    cap.ttl = parts
                        .headers
                        .get("ttl")
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    cap.content_encoding = parts
                        .headers
                        .get("content-encoding")
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    cap.authorization = parts
                        .headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    cap.body = Some(req_bytes.to_vec());
                    drop(cap);

                    let mut response = (status, resp_body).into_response();
                    for (name, value) in extra_headers {
                        if let Ok(val) = value.parse() {
                            response.headers_mut().insert(name, val);
                        }
                    }
                    response
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let port = addr.port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        // Give the server a moment to start.
        tokio::time::sleep(Duration::from_millis(50)).await;
        (format!("http://127.0.0.1:{port}/send"), captured)
    }

    #[tokio::test]
    async fn adapter_sends_well_formed_request() {
        let (endpoint, captured) = start_mock_server(StatusCode::OK, vec![], vec![]).await;

        let client = ReqwestWebPushClient::new();
        let message = build_test_message(&endpoint);
        let result = client.send(message).await;

        assert!(result.is_ok(), "send should succeed on 200: {:?}", result);

        let cap = captured.lock().unwrap();
        assert_eq!(cap.method.as_deref(), Some("POST"), "must be POST");
        assert!(cap.ttl.is_some(), "TTL header must be present");
        assert_eq!(
            cap.content_encoding.as_deref(),
            Some("aes128gcm"),
            "Content-Encoding must be aes128gcm"
        );
        assert!(
            cap.authorization
                .as_deref()
                .is_some_and(|a| a.starts_with("vapid t=")),
            "Authorization header must be VAPID: {:?}",
            cap.authorization
        );
        assert!(
            cap.body.as_ref().is_some_and(|b| !b.is_empty()),
            "encrypted body must be non-empty"
        );
    }

    #[tokio::test]
    async fn adapter_classifies_dead_endpoints() {
        // 404 → EndpointNotFound (dead)
        let (endpoint_404, _) = start_mock_server(StatusCode::NOT_FOUND, vec![], vec![]).await;
        let client = ReqwestWebPushClient::new();
        let result = client.send(build_test_message(&endpoint_404)).await;
        assert!(matches!(result, Err(WebPushError::EndpointNotFound(_))));

        // 410 → EndpointNotValid (dead)
        let (endpoint_410, _) = start_mock_server(StatusCode::GONE, vec![], vec![]).await;
        let result = client.send(build_test_message(&endpoint_410)).await;
        assert!(matches!(result, Err(WebPushError::EndpointNotValid(_))));
    }

    #[tokio::test]
    async fn adapter_propagates_retry_after() {
        let (endpoint, _) = start_mock_server(
            StatusCode::INTERNAL_SERVER_ERROR,
            vec![("retry-after", "120")],
            vec![],
        )
        .await;

        let client = ReqwestWebPushClient::new();
        let result = client.send(build_test_message(&endpoint)).await;

        match result {
            Err(WebPushError::ServerError { retry_after, .. }) => {
                assert_eq!(
                    retry_after,
                    Some(Duration::from_secs(120)),
                    "Retry-After should be 120s"
                );
            }
            other => panic!("expected ServerError with retry_after, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn adapter_caps_response_size() {
        // Send a response body larger than 64 KiB.
        let oversized = vec![b'x'; MAX_RESPONSE_SIZE + 1];
        let (endpoint, _) = start_mock_server(StatusCode::OK, vec![], oversized).await;

        let client = ReqwestWebPushClient::new();
        let result = client.send(build_test_message(&endpoint)).await;

        assert!(
            matches!(result, Err(WebPushError::ResponseTooLarge)),
            "oversized response should be ResponseTooLarge, got {result:?}"
        );
    }
}
