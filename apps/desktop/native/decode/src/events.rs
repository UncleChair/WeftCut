//! Event sink — bridges component events to Electron main via a napi
//! `ThreadsafeFunction`. TWIN of native/src/events.rs (kept tiny on purpose;
//! the `{event, payload}` JSON envelope must match — main's relay parses both).

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

pub struct TsfnEventSink {
    tsfn: ThreadsafeFunction<String>,
}

impl TsfnEventSink {
    pub fn new(tsfn: ThreadsafeFunction<String>) -> Self {
        Self { tsfn }
    }
}

impl EventSink for TsfnEventSink {
    fn emit(&self, event: &str, payload: Value) {
        let msg = serde_json::json!({ "event": event, "payload": payload }).to_string();
        let _ = self
            .tsfn
            .call(Ok(msg), ThreadsafeFunctionCallMode::NonBlocking);
    }
}
