//! Transport-neutral wire envelope.
//!
//! WebSocket and stdio are transport *adapters* over the same application
//! protocol — they carry the same `ClientMessage` / `ServerMessage` enums and
//! the same [`PROTOCOL_VERSION`](crate::wire::PROTOCOL_VERSION). This module
//! provides a thin envelope wrapper so that future per-transport metadata
//! (correlation ids, tracing spans, etc.) has a place to live without touching
//! the existing message enums, which remain the single source of truth and are
//! **not** modified here.
//!
//! Phase 0 status: the envelope composes the existing enums and round-trips
//! through serde. The stdio framing codec (length-prefixed) lives in
//! [`crate::frame`]; the stdio adapter runtime that reads/writes those frames
//! is a later phase and is **not** implemented here.

use serde::{Deserialize, Serialize};

#[cfg(test)]
use serde::de::DeserializeOwned;

use crate::wire::{ClientMessage, ServerMessage};

/// A thin transport-neutral envelope wrapping a logical protocol message.
///
/// The envelope itself carries no fields beyond the inner `message`. It exists
/// so that future per-transport metadata (correlation ids, tracing) can be
/// added as optional envelope fields without altering `ClientMessage` or
/// `ServerMessage`. Framing/length-prefix concerns live in the codec
/// ([`crate::frame`]), not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireEnvelope<T> {
    pub message: T,
}

impl<T> WireEnvelope<T> {
    /// Wrap a logical message in a new envelope.
    pub fn new(message: T) -> Self {
        Self { message }
    }
}

/// Envelope carrying a client→server message.
pub type ClientEnvelope = WireEnvelope<ClientMessage>;

/// Envelope carrying a server→client message.
pub type ServerEnvelope = WireEnvelope<ServerMessage>;

/// Round-trip an envelope through serialize→deserialize and compare the JSON
/// representation before and after, since the message enums do not derive
/// `PartialEq`. Returns `true` if the round-trip is lossless.
#[cfg(test)]
fn roundtrip_json<T>(envelope: &WireEnvelope<T>) -> bool
where
    T: Serialize + DeserializeOwned,
{
    let json = serde_json::to_value(envelope).expect("serialize envelope");
    let back: WireEnvelope<T> = serde_json::from_value(json.clone()).expect("deserialize envelope");
    let json_back = serde_json::to_value(&back).expect("re-serialize envelope");
    json == json_back
}

#[cfg(test)]
mod tests {
    //! Named validation: `wire_envelope_roundtrip_tests`.
    //!
    //! These mirror the existing `roundtrip_*` tests in `wire.rs` but operate
    //! on the transport envelope, verifying the envelope composes the existing
    //! enums without altering them.

    use super::*;
    use crate::session_driver::{SessionDriverEvent, SessionEventBase, SessionRef, Timestamp};
    use crate::wire::{ResumeToken, ServerMessage};

    fn make_session_ref() -> SessionRef {
        SessionRef {
            workspace_id: "ws1".into(),
            session_id: "s1".into(),
        }
    }

    #[test]
    fn client_envelope_roundtrips_hello() {
        let msg = ClientMessage::Hello {
            auth: Some("token".into()),
            resume: Some(ResumeToken {
                session_id: "s1".into(),
                epoch: 1,
                seq: 5,
            }),
        };
        let env = ClientEnvelope::new(msg);
        assert!(roundtrip_json(&env), "ClientEnvelope<Hello> round-trip");
    }

    #[test]
    fn server_envelope_roundtrips_hello_without_build_sha() {
        let msg = ServerMessage::Hello {
            protocol_version: 5,
            server_id: "srv-abc".into(),
            server_label: "".into(),
            data_dir: "/data".into(),
            build_sha: None,
        };
        let env = ServerEnvelope::new(msg);
        assert!(
            roundtrip_json(&env),
            "ServerEnvelope<Hello> without buildSha round-trip"
        );
    }

    #[test]
    fn server_envelope_roundtrips_hello_with_build_sha() {
        let msg = ServerMessage::Hello {
            protocol_version: 5,
            server_id: "srv-abc".into(),
            server_label: "prod".into(),
            data_dir: "/data".into(),
            build_sha: Some("abcdef0123".into()),
        };
        let env = ServerEnvelope::new(msg);
        assert!(
            roundtrip_json(&env),
            "ServerEnvelope<Hello> with buildSha round-trip"
        );
    }

    #[test]
    fn server_envelope_roundtrips_seed() {
        let msg = ServerMessage::Seed {
            session_id: Some("s1".into()),
            epoch: 0,
            seq: 0,
            events: vec![],
        };
        let env = ServerEnvelope::new(msg);
        assert!(roundtrip_json(&env), "ServerEnvelope<Seed> round-trip");
    }

    #[test]
    fn server_envelope_roundtrips_event() {
        let ev = SessionDriverEvent::SessionReset {
            base: SessionEventBase {
                session_ref: make_session_ref(),
                timestamp: Timestamp::from("2026-07-03T12:00:00Z"),
                run_id: None,
            },
        };
        let msg = ServerMessage::Event {
            event: ev,
            epoch: 1,
            seq: 3,
        };
        let env = ServerEnvelope::new(msg);
        assert!(roundtrip_json(&env), "ServerEnvelope<Event> round-trip");
    }

    #[test]
    fn server_envelope_roundtrips_pong() {
        let env = ServerEnvelope::new(ServerMessage::Pong);
        assert!(roundtrip_json(&env), "ServerEnvelope<Pong> round-trip");
    }

    #[test]
    fn envelope_new_constructs_correctly() {
        let env = ServerEnvelope::new(ServerMessage::Pong);
        match env.message {
            ServerMessage::Pong => {}
            _ => panic!("expected Pong"),
        }
    }
}
