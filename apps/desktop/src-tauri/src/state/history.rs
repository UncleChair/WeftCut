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

use super::actor::{Actor, EntityRef};
use super::ids::{CheckpointId, MediaId, OpId, new_id};
use super::media::MediaItem;
use super::project::Project;

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
        }
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
}
