//! Workspace tracking — where on disk the current project folder lives.
//!
//! Per `docs/data-model.md` Q1, a workspace is a folder. `WorkspaceSlot`
//! is the runtime singleton that remembers the current workspace path; it's
//! `None` only during the blank-on-boot window before any `project_save_as` /
//! `project_open` runs (Phase B's startup screen will make that window
//! unreachable).
//!
//! The slot is updated by `project_save_as` / `project_open` in commands.rs
//! and read wherever a job or command needs the workspace root (cache
//! layout, import copies, fs-scope grants). Media paths themselves don't
//! route through here: `io::load_from_dir` reconciles `MediaItem.path_abs`
//! from the workspace-relative `path_rel` at load time, so consumers read
//! `path_abs` directly.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

/// Allow the fs plugin to read/write under the open workspace folder.
/// L2 motif raster frames live at `<workspace>/Cache/raster/...`, a
/// user-chosen path the static `default.json` scope can't express. Grant it
/// at every workspace-activation site. Best-effort: a scope error is logged,
/// not fatal — the editor still runs, L2 just degrades to live rastering.
pub fn allow_workspace_fs<R: tauri::Runtime>(app: &AppHandle<R>, workspace: &Path) {
    if let Err(e) = app.fs_scope().allow_directory(workspace, true) {
        tracing::warn!("fs_scope allow {}: {e:#}", workspace.display());
    }
}

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

    /// Set the workspace path. Called from `project_save_as` and
    /// `project_open` right after the on-disk operation succeeds.
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
