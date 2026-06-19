//! Event sink — bridges Rust domain events to the Electron main process via a
//! napi `ThreadsafeFunction`. The production impl wraps one TSFN; the test
//! impl records emits.

use std::sync::{Arc, Mutex};

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Production sink: serialize `{event, payload}` to a JSON string and call the
/// JS callback non-blocking. Match the TSFN generic arity to the PoC's
/// `subscribe_and_fire`.
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
        let _ = self.tsfn.call(Ok(msg), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Test sink: records `(event, payload)` for assertions.
#[derive(Clone, Default)]
pub struct VecEventSink {
    pub events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl VecEventSink {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn names(&self) -> Vec<String> {
        self.events.lock().unwrap().iter().map(|(n, _)| n.clone()).collect()
    }
}

impl EventSink for VecEventSink {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
}
