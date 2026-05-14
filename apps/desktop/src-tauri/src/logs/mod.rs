//! Status / log subsystem. See `docs/status-log-system.md` for the
//! full design.
//!
//! The public surface is intentionally small:
//!   * `LogEntry` / `LogEntryInput` — schema (see `entry.rs`).
//!   * `LogBus` — the running ring + broadcast + JSONL writer (see
//!     `bus.rs`).
//!   * `LogBusSlot` — workspace-scoped slot; `None` pre-workspace.
//!   * `LogBusLayer` — tracing-subscriber bridge for system errors.
//!
//! Producers call `slot.emit(LogEntryInput { ... })`. The bus stamps
//! id + ts, redacts `details`, broadcasts, and persists.

pub mod bus;
pub mod entry;
pub mod redact;
pub mod tracing_layer;
pub mod writer;

pub use bus::{EVENT_LOG_ENTRY, LogBus, LogBusSlot};
pub use entry::{LogCategory, LogEntry, LogEntryInput, LogLevel, LogSource, OpState};
pub use tracing_layer::LogBusLayer;

/// Convenience: emit a log entry through an `AppHandle`. Used by
/// producers (jobs, export, MCP server) that hold an `AppHandle` but
/// don't manage their own `LogBusSlot` clone. No-op pre-workspace.
pub fn emit_via_app(app: &tauri::AppHandle, input: LogEntryInput) {
    use tauri::Manager;
    if let Some(slot) = app.try_state::<LogBusSlot>() {
        slot.emit(input);
    }
}
