//! Schema for log entries. See `docs/status-log-system.md` for the full
//! design — this file is the canonical type definition the rest of the
//! system (ring buffer, JSONL writer, frontend bridge, MCP transcript)
//! reads from.
//!
//! `LogEntry` is `serde::Serialize` for the wire (Tauri events + JSONL).
//! IDs are UUIDv7 — monotonic + time-sortable, same role as the ULID the
//! design talks about; we already depend on `uuid::Uuid::now_v7` and
//! adding a `ulid` crate just for naming wasn't worth it.
//!
//! Pre-translation policy: `message` is the canonical English string,
//! mandatory. `i18n_key` + `i18n_args` are optional hints for the UI to
//! translate when zh-CN is active; the JSONL forensic record always has
//! the English fallback.
//!
//! Lifecycle (recap): the producer fills out an entry; `LogBus::emit`
//! stamps `id` + `ts` and broadcasts. The redactor runs before
//! persistence and broadcast — see `redact.rs`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Five-level severity, matching `tracing`'s conventions. The frontend's
/// default filter is `Info+`; `Trace` and `Debug` are persisted but
/// hidden by default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// Producer-category for filtering. Fixed enum with an `Other(String)`
/// escape hatch so a new category can land without a backend release.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name")]
pub enum LogCategory {
    Shortcut,
    Mcp,
    Job,
    Export,
    Import,
    Project,
    System,
    Agent,
    Other(String),
}

/// Who originated the entry. `Agent { client }` carries the MCP client
/// identifier (e.g. "claude-desktop") so the UI can distinguish multiple
/// concurrent agents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "client")]
pub enum LogSource {
    User,
    Agent { client: String },
    System,
}

/// State of a long-running op grouped under one `op_id`. Producers emit
/// one entry per state change; the UI collapses by `op_id`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", content = "progress")]
pub enum OpState {
    Started,
    /// 0.0 .. 1.0
    Progress(f32),
    Ok,
    Err,
}

/// One log entry — the unit of broadcast, ring storage, and JSONL line.
///
/// `id` and `ts` are stamped by `LogBus::emit` from a `LogEntryInput`;
/// frontend producers send the input shape and let the bus assign the
/// stable identity so the broadcast and JSONL agree.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: Uuid,
    pub ts: DateTime<Utc>,
    pub level: LogLevel,
    pub category: LogCategory,
    pub source: LogSource,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op_state: Option<OpState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// Input shape — same fields as `LogEntry` minus the bus-assigned `id`
/// and `ts`. Producers (both Rust and frontend) construct this; the bus
/// stamps identity. `op_id` is *not* assigned by the bus because grouped
/// state-change entries need a stable id supplied by the producer.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LogEntryInput {
    pub level: LogLevel,
    pub category: LogCategory,
    pub source: LogSource,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op_state: Option<OpState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl Default for LogLevel {
    fn default() -> Self {
        Self::Info
    }
}

impl Default for LogCategory {
    fn default() -> Self {
        Self::System
    }
}

impl Default for LogSource {
    fn default() -> Self {
        Self::System
    }
}

impl LogEntry {
    /// Stamp `id` + `ts` on a `LogEntryInput`. Sole construction path
    /// through the bus — keeps every producer honest about not minting
    /// its own ids.
    pub fn from_input(input: LogEntryInput) -> Self {
        Self {
            id: Uuid::now_v7(),
            ts: Utc::now(),
            level: input.level,
            category: input.category,
            source: input.source,
            message: input.message,
            i18n_key: input.i18n_key,
            i18n_args: input.i18n_args,
            op_id: input.op_id,
            op_state: input.op_state,
            details: input.details,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_entry_round_trips_json() {
        let input = LogEntryInput {
            level: LogLevel::Warn,
            category: LogCategory::Mcp,
            source: LogSource::Agent { client: "claude-desktop".into() },
            message: "MCP tool call failed".into(),
            i18n_key: Some("log.mcp.failed".into()),
            i18n_args: Some(serde_json::json!({ "tool": "add_layer" })),
            op_id: Some(Uuid::now_v7()),
            op_state: Some(OpState::Err),
            details: Some(serde_json::json!({ "err": "bad arg" })),
        };
        let entry = LogEntry::from_input(input);
        let json = serde_json::to_string(&entry).expect("ser");
        let parsed: LogEntry = serde_json::from_str(&json).expect("de");
        assert_eq!(parsed.message, entry.message);
        assert_eq!(parsed.level, entry.level);
        assert_eq!(parsed.category, entry.category);
    }

    #[test]
    fn category_other_round_trips() {
        let cat = LogCategory::Other("custom".into());
        let s = serde_json::to_string(&cat).expect("ser");
        let back: LogCategory = serde_json::from_str(&s).expect("de");
        assert_eq!(back, cat);
    }

    #[test]
    fn op_state_progress_serializes() {
        let s = serde_json::to_string(&OpState::Progress(0.42)).expect("ser");
        // serde tag-content form on a tuple variant produces
        // `{"state":"Progress","progress":0.42}`.
        assert!(s.contains("Progress"));
        let back: OpState = serde_json::from_str(&s).expect("de");
        match back {
            OpState::Progress(v) => assert!((v - 0.42).abs() < 1e-6),
            other => panic!("expected Progress, got {other:?}"),
        }
    }
}
