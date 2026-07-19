//! `LogBus` — owns the in-memory ring, broadcast channel, and a sender
//! to the JSONL writer task. Built by `LogBus::spawn(...)` when a
//! workspace is opened; rotated when the workspace switches.
//!
//! See `docs/status-log.md` for the full design.
//!
//! Pre-workspace policy (strict): the slot is `None` until
//! `project_save_as` / `project_open` / `project_new_workspace`
//! installs a bus. Producers must check `slot.current()` before
//! emitting — `emit` is otherwise a no-op (silent drop on the caller
//! side via the `if let Some(bus)` pattern).
//!
//! Concurrency notes:
//!   * `emit` is non-blocking. It pushes to a parking_lot RwLock-guarded
//!     ring (microseconds), then `broadcast::Sender::send` (non-blocking,
//!     drops if no subscribers) and `mpsc::Sender::try_send` (drops the
//!     JSONL line on full; one warning event is emitted by the writer
//!     itself, not from here, to avoid feedback).
//!   * Never call `tracing::*!` macros inside `emit` — see
//!     [[feedback_async_block_on_in_async]] for the analogous trap.
//!     A future `tracing_layer` forwards `tracing::error!` events
//!     into `emit`, so re-emitting tracing events inside `emit` would
//!     recurse.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::{broadcast, mpsc};

use crate::events::EventSink;

use super::entry::{LogEntry, LogEntryInput};
use super::redact::redact_and_cap;
use super::writer;

/// In-memory ring capacity. ~500 bytes/entry on average → ~500 KB.
const RING_CAPACITY: usize = 1000;

/// Broadcast channel slack. Each napi-event bridge subscriber drains at
/// the speed of the `EventSink::emit` napi bridge, which is fast; 256 covers
/// bursty MCP agent activity without coercing the bus into blocking.
const BROADCAST_CAPACITY: usize = 256;

/// JSONL writer mpsc bound. Bursts beyond this drop the line with a
/// counter the writer task surfaces on its next flush.
const WRITER_CAPACITY: usize = 4096;

/// napi event name carrying each new `LogEntry`. The frontend
/// `useLogStore` listener fans these into the Zustand store.
pub const EVENT_LOG_ENTRY: &str = "log:entry";

/// Cloneable handle on a running bus. Internally `Arc<Inner>` — cheap
/// to clone; producers hold this directly.
#[derive(Clone)]
pub struct LogBus {
    inner: Arc<Inner>,
}

struct Inner {
    ring: RwLock<VecDeque<LogEntry>>,
    broadcast: broadcast::Sender<LogEntry>,
    /// Dropping the bus drops this sender, which closes the mpsc and
    /// makes the writer task exit cleanly after flushing.
    writer: mpsc::Sender<LogEntry>,
}

impl LogBus {
    /// Spawn a fresh bus rooted at `<workspace>/Logs/`. Creates the dir
    /// if needed. Returns immediately; the writer task runs in the
    /// background. Old session files (>20) are pruned by the writer on
    /// startup.
    pub fn spawn(workspace: &PathBuf, events: Arc<dyn EventSink>) -> Self {
        let logs_dir = workspace.join("Logs");
        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (writer_tx, writer_rx) = mpsc::channel(WRITER_CAPACITY);

        // Writer task — appends each entry as one JSON line; rotates
        // session files; prunes oldest. Owns its own file handle and
        // is the only writer. Exits when the mpsc closes (last bus
        // clone dropped).
        tokio::spawn(writer::run(logs_dir, writer_rx));

        // Broadcast → UI-event bridge. One subscriber, fan-out into
        // the renderer as `log:entry` events. Spawned on the bus's own
        // lifetime — when the bus is replaced, this task's broadcast
        // receiver returns Closed and the loop exits.
        let mut bridge_rx = broadcast_tx.subscribe();
        let events_for_bridge = events.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match bridge_rx.recv().await {
                    Ok(entry) => {
                        let payload =
                            serde_json::to_value(&entry).unwrap_or(serde_json::Value::Null);
                        events_for_bridge.emit(EVENT_LOG_ENTRY, payload);
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });

        Self {
            inner: Arc::new(Inner {
                ring: RwLock::new(VecDeque::with_capacity(RING_CAPACITY)),
                broadcast: broadcast_tx,
                writer: writer_tx,
            }),
        }
    }

    /// Emit one entry. Non-blocking. The redact + size-cap pass runs on
    /// `details` before broadcast + persistence: secrets are scrubbed and
    /// payloads over ~4 KB are replaced with a truncated preview.
    pub fn emit(&self, input: LogEntryInput) {
        let mut entry = LogEntry::from_input(input);
        if let Some(details) = entry.details.take() {
            entry.details = Some(redact_and_cap(details));
        }
        // Ring: push back, evict front when over cap.
        {
            let mut ring = self.inner.ring.write();
            if ring.len() >= RING_CAPACITY {
                ring.pop_front();
            }
            ring.push_back(entry.clone());
        }
        // Broadcast: ignore "no subscribers" — that's the normal state
        // before the renderer connects its listener.
        let _ = self.inner.broadcast.send(entry.clone());
        // Persistence: try-send; drop the line on saturation. The
        // writer counts drops itself.
        let _ = self.inner.writer.try_send(entry);
    }

    /// Snapshot the current ring. Used by `log_list` on frontend mount.
    pub fn list(&self) -> Vec<LogEntry> {
        let ring = self.inner.ring.read();
        ring.iter().cloned().collect()
    }

    /// Clear the in-memory ring. Does NOT truncate the JSONL file.
    pub fn clear(&self) {
        self.inner.ring.write().clear();
    }
}

/// A workspace-scoped slot for the current `LogBus`. `None` before any
/// workspace is opened — every producer's emit path must short-circuit
/// when `current()` returns `None`.
///
/// Lifecycle: `project_save_as` / `project_open` / `project_new_workspace`
/// call `install(...)` after the on-disk workspace is set. Switching
/// workspaces replaces the bus, which drops the old one and exits its
/// writer + bridge tasks.
#[derive(Clone, Default)]
pub struct LogBusSlot {
    inner: Arc<RwLock<Option<LogBus>>>,
}

impl LogBusSlot {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn current(&self) -> Option<LogBus> {
        self.inner.read().clone()
    }

    pub fn install(&self, bus: LogBus) {
        *self.inner.write() = Some(bus);
    }

    /// Convenience: emit if a bus exists, else drop. Producers usually
    /// want this rather than the `if let Some` dance.
    pub fn emit(&self, input: LogEntryInput) {
        if let Some(bus) = self.current() {
            bus.emit(input);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::entry::{LogCategory, LogLevel, LogSource};

    fn input(msg: &str) -> LogEntryInput {
        LogEntryInput {
            level: LogLevel::Info,
            category: LogCategory::System,
            source: LogSource::System,
            message: msg.into(),
            ..Default::default()
        }
    }

    #[test]
    fn slot_starts_empty() {
        let slot = LogBusSlot::new();
        assert!(slot.current().is_none());
        // Emit on empty slot is a quiet no-op.
        slot.emit(input("ignored"));
    }
}
