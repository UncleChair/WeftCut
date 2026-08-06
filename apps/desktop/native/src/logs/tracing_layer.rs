//! `tracing-subscriber` layer that forwards `tracing::error!` events
//! from our crate into the `LogBus`. Scope is intentionally narrow:
//!
//!   * Level filter: `Error` only — every `tracing::error!` from our
//!     code becomes a `category=System, level=Error` log entry.
//!   * Target filter: only events whose target starts with `weftcut`
//!     (our binary) or `weftcut_lib` (the lib crate). Third-party
//!     crates' errors don't leak into the user-visible log.
//!
//! Recursion guard: this layer NEVER calls `tracing::*!` macros — they
//! would re-enter `on_event` and recurse. Internal failures (e.g.
//! serialization errors in the field visitor) are silently dropped.

use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use super::bus::LogBusSlot;
use super::entry::{LogCategory, LogEntryInput, LogLevel, LogSource};

#[derive(Clone)]
pub struct LogBusLayer {
    slot: LogBusSlot,
}

impl LogBusLayer {
    pub fn new(slot: LogBusSlot) -> Self {
        Self { slot }
    }
}

impl<S: Subscriber> Layer<S> for LogBusLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() != Level::ERROR {
            return;
        }
        let target = meta.target();
        if !(target.starts_with("weftcut") || target.starts_with("weftcut_lib")) {
            return;
        }

        // Message + structured fields are pulled out by `MessageVisitor`.
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let message = visitor.message.unwrap_or_else(|| meta.target().to_string());

        let details = if visitor.fields.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(visitor.fields))
        };

        // Drop on bus-absent so pre-workspace tracing errors are
        // genuinely refused per the design.
        self.slot.emit(LogEntryInput {
            level: LogLevel::Error,
            category: LogCategory::System,
            source: LogSource::System,
            message,
            details,
            ..Default::default()
        });
    }
}

#[derive(Default)]
struct MessageVisitor {
    message: Option<String>,
    fields: serde_json::Map<String, serde_json::Value>,
}

impl tracing::field::Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let name = field.name();
        let formatted = format!("{value:?}");
        if name == "message" {
            // tracing formats the macro's message arg with Debug — strip
            // the surrounding quotes if any.
            self.message = Some(formatted.trim_matches('"').to_string());
        } else {
            self.fields
                .insert(name.to_string(), serde_json::Value::String(formatted));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        let name = field.name();
        if name == "message" {
            self.message = Some(value.to_string());
        } else {
            self.fields.insert(
                name.to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }
}
