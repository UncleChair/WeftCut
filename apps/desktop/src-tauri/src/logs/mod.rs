//! Status / log subsystem. See `docs/status-log.md` for the
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
/// producers (jobs, MCP server, motifs) that hold an `AppHandle` but
/// don't manage their own `LogBusSlot` clone. No-op pre-workspace.
///
/// Gated on the feature set of its only callers (all deferred): once those
/// stages migrate off `tauri::AppHandle`, this helper is replaced by a
/// `&dyn EventSink`-shaped path. Ungated `logs` carries no `tauri` reference.
///
/// S4a migrated the MCP module off `emit_via_app` (it now emits through
/// `Backend::log_slot`), so the `mcp` gate is gone — `motifs` (S5, still
/// `tauri::AppHandle`-based via `motifs/staleness.rs`) is the sole remaining
/// caller. Re-add a gate only when another `tauri`-holding caller appears.
#[cfg(feature = "motifs")]
pub fn emit_via_app(app: &tauri::AppHandle, input: LogEntryInput) {
    use tauri::Manager;
    if let Some(slot) = app.try_state::<LogBusSlot>() {
        slot.emit(input);
    }
}
