//! Undo/redo + named checkpoints. Snapshot ring with structural sharing —
//! `imbl` makes per-edit memory cost `O(depth)`, not `O(state)`.
//!
//! Cursor model: `snapshots[cursor]` is the current state. New commits truncate
//! the redo tail. Checkpoints are stored separately so they survive truncation.

// `HistoryEntry`/`NamedCheckpoint` fields (op_id, actor, timestamp, summary,
// affected, id) are recorded for the agent change-feed and history-listing
// API; not all read in the lib build.
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::actor::{Actor, EntityRef};
use super::composition::Composition;
use super::ids::{CheckpointId, MediaId, OpId, new_id};
use super::media::MediaItem;
use super::project::{Project, ProjectSettings};

pub const DEFAULT_CAP: usize = 200;

#[derive(Clone, Debug)]
pub struct HistoryEntry {
    pub op_id: OpId,
    pub actor: Actor,
    pub timestamp: DateTime<Utc>,
    pub summary: String,
    pub affected: Vec<EntityRef>,
    pub snapshot: Arc<Project>,
}

#[derive(Clone, Debug)]
pub struct NamedCheckpoint {
    pub id: CheckpointId,
    pub label: String,
    pub actor: Actor,
    pub created_at: DateTime<Utc>,
    pub snapshot: Arc<Project>,
}

/// Plain `std` collections rather than `imbl::*` — history entries don't need
/// structural sharing (each is a discrete event), and stacking imbl-inside-imbl
/// blows the trait-recursion limit when proving `Send`/`Sync` for the actor's
/// future. The `Arc<Project>` inside each entry preserves the cheap-clone story
/// for the actual project state, which is what we care about.
pub struct History {
    snapshots: VecDeque<HistoryEntry>,
    cursor: usize,
    cap: usize,
    checkpoints: HashMap<CheckpointId, NamedCheckpoint>,
    /// When `Some(reason)`, all revert paths (undo / redo / restore
    /// checkpoint) reject with `CommandError::HistoryLocked`. The agent
    /// takes this lock via `lock_history(reason)` and drops it via
    /// `unlock_history()`. Not persisted to disk — released on workspace
    /// change (via `reset`) and on agent-session end (via the Tauri
    /// command).
    lock: Option<String>,
}

impl History {
    pub fn new(initial: Arc<Project>, actor: Actor) -> Self {
        let entry = HistoryEntry {
            op_id: new_id(),
            actor,
            timestamp: Utc::now(),
            summary: "Initial".to_string(),
            affected: Vec::new(),
            snapshot: initial,
        };
        let mut snapshots = VecDeque::new();
        snapshots.push_back(entry);
        Self {
            snapshots,
            cursor: 0,
            cap: DEFAULT_CAP,
            checkpoints: HashMap::new(),
            lock: None,
        }
    }

    /// Take the revert-lock, recording `reason` (shown in the agent-mode
    /// record-panel header and any rejected-revert error). Last writer
    /// wins — calling while already locked replaces the reason.
    pub fn lock(&mut self, reason: String) {
        self.lock = Some(reason);
    }

    /// Release the revert-lock. Idempotent — `unlock` while already
    /// unlocked is a no-op.
    pub fn unlock(&mut self) {
        self.lock = None;
    }

    /// Current lock reason if any.
    pub fn lock_reason(&self) -> Option<&str> {
        self.lock.as_deref()
    }

    pub fn current(&self) -> Arc<Project> {
        self.snapshots[self.cursor].snapshot.clone()
    }

    pub fn record(&mut self, entry: HistoryEntry) {
        // Truncate redo tail.
        self.snapshots.truncate(self.cursor + 1);
        self.snapshots.push_back(entry);
        // Trim from front if cap exceeded. Checkpoints survive — they're stored
        // separately and reference snapshots via their own `Arc<Project>`.
        while self.snapshots.len() > self.cap {
            self.snapshots.pop_front();
        }
        self.cursor = self.snapshots.len() - 1;
    }

    pub fn undo(&mut self) -> Option<Arc<Project>> {
        if self.cursor == 0 {
            return None;
        }
        self.cursor -= 1;
        Some(self.snapshots[self.cursor].snapshot.clone())
    }

    pub fn redo(&mut self) -> Option<Arc<Project>> {
        if self.cursor + 1 >= self.snapshots.len() {
            return None;
        }
        self.cursor += 1;
        Some(self.snapshots[self.cursor].snapshot.clone())
    }

    pub fn checkpoint(&mut self, label: String, actor: Actor) -> CheckpointId {
        let id = new_id();
        let cp = NamedCheckpoint {
            id,
            label,
            actor,
            created_at: Utc::now(),
            snapshot: self.current(),
        };
        self.checkpoints.insert(id, cp);
        id
    }

    pub fn restore_checkpoint(&mut self, id: CheckpointId) -> Option<Arc<Project>> {
        let cp = self.checkpoints.get(&id)?.clone();
        let entry = HistoryEntry {
            op_id: new_id(),
            actor: cp.actor.clone(),
            timestamp: Utc::now(),
            summary: format!("Restored checkpoint '{}'", cp.label),
            affected: Vec::new(),
            snapshot: cp.snapshot.clone(),
        };
        self.record(entry);
        Some(cp.snapshot)
    }

    pub fn list_checkpoints(&self) -> Vec<NamedCheckpoint> {
        let mut v: Vec<NamedCheckpoint> = self.checkpoints.values().cloned().collect();
        v.sort_by_key(|c| c.created_at);
        v
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn len(&self) -> usize {
        self.snapshots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.snapshots.is_empty()
    }

    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_redo(&self) -> bool {
        self.cursor + 1 < self.snapshots.len()
    }

    /// Snapshot-free view of recent history for read-only consumers (UI panels,
    /// MCP `project://history` resource). Returns the last `limit` entries plus
    /// the checkpoint list, ordered oldest → newest.
    pub fn view(&self, limit: usize) -> HistoryView {
        let total = self.snapshots.len();
        let take = limit.min(total);
        let start = total - take;
        let ops: Vec<HistoryEntrySummary> = self
            .snapshots
            .iter()
            .skip(start)
            .map(HistoryEntrySummary::from)
            .collect();
        let mut checkpoints: Vec<NamedCheckpointSummary> = self
            .checkpoints
            .values()
            .map(NamedCheckpointSummary::from)
            .collect();
        checkpoints.sort_by_key(|c| c.created_at);
        HistoryView {
            ops,
            cursor: self.cursor,
            len: total,
            checkpoints,
            lock_reason: self.lock.clone(),
        }
    }

    /// Replace the `media_pool` of every snapshot (history + checkpoints) with
    /// `new_pool`. This is the "media imports stand outside of editing
    /// history" path: imports add to the pool, and the pool stays whether the
    /// user undoes or redoes through edits made afterwards. No new history
    /// entry is recorded; cursor doesn't move.
    ///
    /// Cost: clones each `Project` once, but `imbl` structural sharing keeps
    /// that cheap — only the `media_pool` field actually diverges; the rest is
    /// shared `Arc`/RRB nodes.
    pub fn replace_media_pool_everywhere(
        &mut self,
        new_pool: imbl::HashMap<MediaId, MediaItem>,
    ) {
        for entry in self.snapshots.iter_mut() {
            let mut p = (*entry.snapshot).clone();
            p.media_pool = new_pool.clone();
            entry.snapshot = Arc::new(p);
        }
        for cp in self.checkpoints.values_mut() {
            let mut p = (*cp.snapshot).clone();
            p.media_pool = new_pool.clone();
            cp.snapshot = Arc::new(p);
        }
    }

    /// Apply the canvas-only fields of `canvas` to every snapshot's
    /// `composition` (history + checkpoints). Each snapshot keeps its own
    /// `duration_us` and `duration_pinned`, since both are editing-shaped
    /// fields that live on the recorded stack. Same out-of-band-edit
    /// pattern as `replace_media_pool_everywhere`.
    pub fn replace_composition_canvas_everywhere(&mut self, canvas: &Composition) {
        for entry in self.snapshots.iter_mut() {
            let mut p = (*entry.snapshot).clone();
            apply_canvas_fields(&mut p.composition, canvas);
            entry.snapshot = Arc::new(p);
        }
        for cp in self.checkpoints.values_mut() {
            let mut p = (*cp.snapshot).clone();
            apply_canvas_fields(&mut p.composition, canvas);
            cp.snapshot = Arc::new(p);
        }
    }

    /// Apply `settings` to every snapshot (history + checkpoints). Project
    /// settings are preference-shaped, not editing-shaped — patching them
    /// everywhere keeps Ctrl-Z from flipping a Settings-panel toggle. Same
    /// out-of-band-edit pattern as `replace_media_pool_everywhere`.
    pub fn replace_settings_everywhere(&mut self, settings: &ProjectSettings) {
        for entry in self.snapshots.iter_mut() {
            let mut p = (*entry.snapshot).clone();
            p.settings = settings.clone();
            entry.snapshot = Arc::new(p);
        }
        for cp in self.checkpoints.values_mut() {
            let mut p = (*cp.snapshot).clone();
            p.settings = settings.clone();
            cp.snapshot = Arc::new(p);
        }
    }

    /// Discard the existing stack and checkpoints, seeding a fresh history
    /// with `initial` as the sole entry. Used by `replace_state` when a
    /// different project is loaded — the old project's snapshots and
    /// checkpoints reference a different `project_id` and have no meaning
    /// against the new state, so they're dropped wholesale.
    pub fn reset(&mut self, initial: Arc<Project>, actor: Actor) {
        let entry = HistoryEntry {
            op_id: new_id(),
            actor,
            timestamp: Utc::now(),
            summary: "Initial".to_string(),
            affected: Vec::new(),
            snapshot: initial,
        };
        self.snapshots.clear();
        self.snapshots.push_back(entry);
        self.cursor = 0;
        self.checkpoints.clear();
        // Workspace swap releases any prior lock — view-mode + lock are
        // ephemeral and shouldn't survive into a different project.
        self.lock = None;
    }
}

/// Copy the canvas-only fields (everything except `duration_us` and
/// `duration_pinned`) from `src` into `dst`. Used by
/// `replace_composition_canvas_everywhere` and by `do_set_composition`
/// when probing the post-state for validation.
fn apply_canvas_fields(dst: &mut Composition, src: &Composition) {
    dst.width = src.width;
    dst.height = src.height;
    dst.fps = src.fps;
    dst.sample_rate = src.sample_rate;
    dst.channels = src.channels;
    dst.color_space = src.color_space;
    dst.background = src.background;
}

/// Read-only summary of a `HistoryEntry` — drops the `Arc<Project>` so the
/// shape is JSON-serializable for MCP/UI consumers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntrySummary {
    pub op_id: OpId,
    pub actor: Actor,
    pub timestamp: DateTime<Utc>,
    pub summary: String,
    pub affected: Vec<EntityRef>,
}

impl From<&HistoryEntry> for HistoryEntrySummary {
    fn from(e: &HistoryEntry) -> Self {
        Self {
            op_id: e.op_id,
            actor: e.actor.clone(),
            timestamp: e.timestamp,
            summary: e.summary.clone(),
            affected: e.affected.clone(),
        }
    }
}

/// Read-only summary of a `NamedCheckpoint` — drops the `Arc<Project>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NamedCheckpointSummary {
    pub id: CheckpointId,
    pub label: String,
    pub actor: Actor,
    pub created_at: DateTime<Utc>,
}

impl From<&NamedCheckpoint> for NamedCheckpointSummary {
    fn from(c: &NamedCheckpoint) -> Self {
        Self {
            id: c.id,
            label: c.label.clone(),
            actor: c.actor.clone(),
            created_at: c.created_at,
        }
    }
}

/// Snapshot-free aggregate exposed to MCP / UI history panels.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryView {
    pub ops: Vec<HistoryEntrySummary>,
    pub cursor: usize,
    pub len: usize,
    pub checkpoints: Vec<NamedCheckpointSummary>,
    /// `Some(reason)` while the revert surface is locked (set by the
    /// agent via `lock_history`). UI uses this to disable Undo / Redo /
    /// Restore buttons with the reason as a tooltip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::project::Project;

    fn fresh() -> History {
        History::new(Arc::new(Project::new_blank("test")), Actor::User)
    }

    #[test]
    fn lock_unset_by_default() {
        let h = fresh();
        assert!(h.lock_reason().is_none());
    }

    #[test]
    fn lock_then_unlock_round_trip() {
        let mut h = fresh();
        h.lock("rendering".into());
        assert_eq!(h.lock_reason(), Some("rendering"));
        h.unlock();
        assert!(h.lock_reason().is_none());
    }

    #[test]
    fn lock_replaces_prior_reason() {
        let mut h = fresh();
        h.lock("a".into());
        h.lock("b".into());
        assert_eq!(h.lock_reason(), Some("b"));
    }

    #[test]
    fn unlock_when_unlocked_is_noop() {
        let mut h = fresh();
        h.unlock();
        h.unlock();
        assert!(h.lock_reason().is_none());
    }

    #[test]
    fn reset_clears_lock() {
        let mut h = fresh();
        h.lock("held".into());
        h.reset(Arc::new(Project::new_blank("other")), Actor::User);
        assert!(h.lock_reason().is_none());
    }

    #[test]
    fn history_view_surfaces_lock_reason() {
        let mut h = fresh();
        let unlocked = h.view(10);
        assert!(unlocked.lock_reason.is_none());
        h.lock("busy".into());
        let locked = h.view(10);
        assert_eq!(locked.lock_reason.as_deref(), Some("busy"));
    }
}
