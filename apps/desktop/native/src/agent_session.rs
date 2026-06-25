//! Agent-session slot — tracks whether the human's UI is currently in
//! agent mode (an MCP client has called `begin_agent_session`).
//!
//! Why this lives outside the project actor:
//!  - View-mode is not project data; mutating it shouldn't dirty the
//!    project document or push undo entries.
//!  - The MCP tool surface should never observe view state; it only
//!    writes the slot. The UI listens.
//!  - One source of truth across MCP writes + UI reads via a single
//!    `Arc<RwLock<Option<AgentSession>>>`.
//!
//! Lifecycle:
//!  - `begin(...)` creates / replaces the session (last writer wins).
//!  - `end()` clears it. Called by the user-exit napi command, by
//!    workspace open/save_as/new, and by MCP-client disconnect.
//!  - Not persisted to disk. App restart always boots into editor mode.
//!
//! Event surface (when paired with an `EventSink`):
//!  - Event `agent_session:changed` with payload `Option<AgentSession>`.
//!    Fires on every begin/end. The UI's `App.tsx` listens.

use std::sync::{Arc, RwLock};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::events::EventSink;

/// Event name. Frontend listens for `Option<AgentSession>` payloads.
pub const EVENT_AGENT_SESSION_CHANGED: &str = "agent_session:changed";

/// What an active agent session carries. Frontend reads `reason` for the
/// record-panel header; `client` distinguishes multiple connected agents
/// in logs / status bar; `started_at` is the lower-bound timestamp the
/// record panel uses to filter the log stream.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AgentSession {
    pub client: String,
    pub reason: String,
    pub started_at: DateTime<Utc>,
}

/// napi-managed slot. Process-global; reset on workspace change.
#[derive(Clone, Default)]
pub struct AgentSessionSlot {
    inner: Arc<RwLock<Option<AgentSession>>>,
}

impl AgentSessionSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// Current session, if any. Cloned out — never hand back a borrow
    /// to the locked value or callers can deadlock on the next `begin`.
    pub fn current(&self) -> Option<AgentSession> {
        self.inner.read().expect("agent_session slot poisoned").clone()
    }

    /// Replace (or install) the session. Returns the previous value so
    /// the caller can decide whether to emit a "session ended" log line
    /// for the displaced one.
    pub fn begin(&self, session: AgentSession) -> Option<AgentSession> {
        let mut guard = self.inner.write().expect("agent_session slot poisoned");
        std::mem::replace(&mut *guard, Some(session))
    }

    /// Clear the session. Returns the prior value (if any) so the
    /// caller can log "session ended" with attribution. Idempotent —
    /// `end()` while already empty returns `None`.
    pub fn end(&self) -> Option<AgentSession> {
        self.inner.write().expect("agent_session slot poisoned").take()
    }
}

/// Convenience: begin a session AND emit `agent_session:changed` so the
/// UI updates immediately. Returns the previous session for caller
/// bookkeeping.
pub fn begin_and_emit(
    events: &dyn EventSink,
    slot: &AgentSessionSlot,
    session: AgentSession,
) -> Option<AgentSession> {
    let prior = slot.begin(session.clone());
    events.emit(EVENT_AGENT_SESSION_CHANGED, serde_json::to_value(Some(session)).unwrap_or(serde_json::Value::Null));
    prior
}

/// Convenience: end the current session AND emit. Returns the prior
/// session for caller bookkeeping.
pub fn end_and_emit(events: &dyn EventSink, slot: &AgentSessionSlot) -> Option<AgentSession> {
    let prior = slot.end();
    events.emit(EVENT_AGENT_SESSION_CHANGED, serde_json::Value::Null);
    prior
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    // ---------- capturing EventSink for emit-wrapper tests ----------

    struct CaptureSink {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl CaptureSink {
        fn new() -> Self {
            Self { events: Mutex::new(Vec::new()) }
        }

        fn drained(&self) -> Vec<(String, serde_json::Value)> {
            self.events.lock().unwrap().drain(..).collect()
        }
    }

    impl EventSink for CaptureSink {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events.lock().unwrap().push((event.to_owned(), payload));
        }
    }

    // ---------- begin_and_emit / end_and_emit ----------

    #[test]
    fn begin_and_emit_sets_slot_and_emits_non_null() {
        let sink = CaptureSink::new();
        let slot = AgentSessionSlot::new();
        let session = AgentSession {
            client: "test-client".into(),
            reason: "unit-test".into(),
            started_at: Utc::now(),
        };
        let prior = begin_and_emit(&sink, &slot, session.clone());
        assert!(prior.is_none(), "slot was empty; prior should be None");
        assert_eq!(slot.current(), Some(session.clone()));
        let events = sink.drained();
        assert_eq!(events.len(), 1);
        let (name, payload) = &events[0];
        assert_eq!(name, EVENT_AGENT_SESSION_CHANGED);
        assert!(!payload.is_null(), "payload should be non-null for an active session");
    }

    #[test]
    fn end_and_emit_clears_slot_and_emits_null() {
        let sink = CaptureSink::new();
        let slot = AgentSessionSlot::new();
        let session = AgentSession {
            client: "test-client".into(),
            reason: "unit-test".into(),
            started_at: Utc::now(),
        };
        slot.begin(session.clone());
        // drain any prior events (slot.begin doesn't call EventSink)
        let _ = sink.drained();
        let prior = end_and_emit(&sink, &slot);
        assert_eq!(prior, Some(session));
        assert!(slot.current().is_none());
        let events = sink.drained();
        assert_eq!(events.len(), 1);
        let (name, payload) = &events[0];
        assert_eq!(name, EVENT_AGENT_SESSION_CHANGED);
        assert!(payload.is_null(), "payload should be null after session ends");
    }

    // ---------- slot unit tests ----------

    fn sample(reason: &str) -> AgentSession {
        AgentSession {
            client: "test-client".into(),
            reason: reason.into(),
            started_at: Utc::now(),
        }
    }

    #[test]
    fn empty_by_default() {
        let slot = AgentSessionSlot::new();
        assert!(slot.current().is_none());
    }

    #[test]
    fn begin_then_current_returns_session() {
        let slot = AgentSessionSlot::new();
        let s = sample("first");
        let prior = slot.begin(s.clone());
        assert!(prior.is_none());
        assert_eq!(slot.current(), Some(s));
    }

    #[test]
    fn begin_replaces_and_returns_prior() {
        let slot = AgentSessionSlot::new();
        let first = sample("first");
        let second = sample("second");
        slot.begin(first.clone());
        let prior = slot.begin(second.clone());
        assert_eq!(prior, Some(first));
        assert_eq!(slot.current(), Some(second));
    }

    #[test]
    fn end_clears_and_returns_prior() {
        let slot = AgentSessionSlot::new();
        let s = sample("only");
        slot.begin(s.clone());
        let prior = slot.end();
        assert_eq!(prior, Some(s));
        assert!(slot.current().is_none());
    }

    #[test]
    fn end_when_empty_is_idempotent() {
        let slot = AgentSessionSlot::new();
        assert!(slot.end().is_none());
        assert!(slot.end().is_none());
    }

    #[test]
    fn agent_session_round_trips_json() {
        let s = sample("filler-removal");
        let json = serde_json::to_string(&s).unwrap();
        let back: AgentSession = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }
}
