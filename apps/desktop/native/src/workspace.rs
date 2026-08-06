//! Workspace tracking — where on disk the current project folder lives.
//!
//! Per `docs/data-model.md`, a workspace is a folder. `WorkspaceSlot`
//! is the runtime singleton that remembers the current workspace path; it's
//! `None` only during the blank-on-boot window before a workspace is opened
//! or created.
//!
//! `NativeBackend::commit_workspace` (napi_backend.rs) is the slot's sole
//! writer, driven by the TS persistence orchestrator; it's read wherever a job
//! or command needs the workspace root (cache
//! layout, import copies, fs-scope grants). Media paths themselves don't
//! route through here: the TS project loader (`persistence.ts`) reconciles
//! `MediaItem.path_abs` from the workspace-relative `path_rel` at load time,
//! so consumers read `path_abs` directly.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

#[derive(Clone, Debug, Default)]
pub struct WorkspaceSlot {
    inner: Arc<RwLock<Option<PathBuf>>>,
}

impl WorkspaceSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// Current workspace path, if any. Cloned out — never hand out a borrow
    /// to the locked value or callers may deadlock on the next `set`.
    pub fn current(&self) -> Option<PathBuf> {
        self.inner.read().expect("workspace slot poisoned").clone()
    }

    pub fn set(&self, workspace: PathBuf) {
        *self.inner.write().expect("workspace slot poisoned") = Some(workspace);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_starts_empty_and_sets() {
        let slot = WorkspaceSlot::new();
        assert!(slot.current().is_none());
        slot.set(PathBuf::from("/tmp/my-proj"));
        assert_eq!(slot.current(), Some(PathBuf::from("/tmp/my-proj")));
    }
}
