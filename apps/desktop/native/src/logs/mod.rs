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

