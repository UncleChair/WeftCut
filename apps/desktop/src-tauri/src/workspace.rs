//! Workspace tracking — where on disk the current project folder lives.
//!
//! Per `docs/workspace-redesign.md` Q1, a workspace is a folder. `WorkspaceSlot`
//! is the runtime singleton that remembers the current workspace path; it's
//! `None` only during the blank-on-boot window before any `project_save_as` /
//! `project_open` runs (Phase B's startup screen will make that window
//! unreachable).
//!
//! The slot is updated by `project_save_as` / `project_open` in commands.rs,
//! and read by `resolve_media_path` so consumers (IR materialization, ffmpeg
//! inputs, jobs, MCP responses) compute absolute paths from the workspace-
//! relative `MediaItem.path_rel` instead of trusting the (legacy, brittle)
//! `path_abs`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::state::media::MediaItem;

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

/// Resolve a media item's absolute path. Per workspace-redesign Q2 the
/// workspace owns its copies of imported media; `path_rel` is authoritative
/// once it's populated (Phase A.4 migration fills it in for legacy projects,
/// Phase C.1 imports set it directly). When the workspace is unknown or
/// `path_rel` is `None`, fall back to the legacy `path_abs` so the editor
/// still works during the transition window.
pub fn resolve_media_path(workspace: Option<&Path>, item: &MediaItem) -> PathBuf {
    match (workspace, item.path_rel.as_ref()) {
        (Some(ws), Some(rel)) => ws.join(rel),
        _ => item.path_abs.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::media::{MediaKind, MediaMetadata};
    use chrono::Utc;

    fn dummy_item(path_abs: &str, path_rel: Option<&str>) -> MediaItem {
        MediaItem {
            id: uuid::Uuid::now_v7(),
            label: None,
            path_abs: PathBuf::from(path_abs),
            path_rel: path_rel.map(PathBuf::from),
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[test]
    fn slot_starts_empty_and_sets() {
        let slot = WorkspaceSlot::new();
        assert!(slot.current().is_none());
        slot.set(PathBuf::from("/tmp/my-proj"));
        assert_eq!(slot.current(), Some(PathBuf::from("/tmp/my-proj")));
    }

    #[test]
    fn resolve_uses_workspace_relative_when_both_available() {
        let ws = Path::new("/projects/doc");
        let item = dummy_item("/legacy/abs/clip.mp4", Some("Media/clip.mp4"));
        assert_eq!(
            resolve_media_path(Some(ws), &item),
            PathBuf::from("/projects/doc").join("Media/clip.mp4"),
        );
    }

    #[test]
    fn resolve_falls_back_to_path_abs_when_no_workspace() {
        let item = dummy_item("/legacy/abs/clip.mp4", Some("Media/clip.mp4"));
        assert_eq!(
            resolve_media_path(None, &item),
            PathBuf::from("/legacy/abs/clip.mp4"),
        );
    }

    #[test]
    fn resolve_falls_back_to_path_abs_when_no_rel() {
        let ws = Path::new("/projects/doc");
        let item = dummy_item("/legacy/abs/clip.mp4", None);
        assert_eq!(
            resolve_media_path(Some(ws), &item),
            PathBuf::from("/legacy/abs/clip.mp4"),
        );
    }
}
