//! Per-workspace timeline view state (zoom + per-track heights) persisted
//! as `<workspace>/view.json`.
//!
//! Why a separate file (not inside `project.json`):
//!  - UI-only knobs shouldn't dirty the project document or push undo
//!    entries when the user just zooms the timeline.
//!  - The MCP tool surface should never observe view state.
//!  - The schema can evolve independently of the project format.
//!
//! Atomic write pattern mirrors `keybindings.rs` / `recents.rs`
//! (temp file + rename) so a crash mid-write can't leave a torn file.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const VIEW_FILE: &str = "view.json";

/// Map of track id (UUID string) → row height in pixels.
pub type TrackHeights = BTreeMap<String, u32>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ViewState {
    /// Timeline horizontal zoom. Pixels per second of timeline time.
    #[serde(default = "default_px_per_sec")]
    pub timeline_px_per_sec: f32,
    /// Per-track lane height in pixels. Tracks absent from the map fall
    /// back to the frontend default.
    #[serde(default)]
    pub track_heights: TrackHeights,
    /// Track ids (UUID strings) whose keyframe sub-lanes are expanded.
    /// Absent / unknown ids are treated as collapsed.
    #[serde(default)]
    pub expanded_tracks: Vec<String>,
}

fn default_px_per_sec() -> f32 {
    80.0
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            timeline_px_per_sec: default_px_per_sec(),
            track_heights: TrackHeights::new(),
            expanded_tracks: Vec::new(),
        }
    }
}

/// Read view state from `<workspace>/view.json`. Returns defaults if the
/// file is missing, empty, or unreadable — view state is best-effort UX,
/// not a correctness anchor.
pub fn load(workspace: &Path) -> ViewState {
    let path = workspace.join(VIEW_FILE);
    if !path.exists() {
        return ViewState::default();
    }
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("view_state read failed ({}): {e:#}", path.display());
            return ViewState::default();
        }
    };
    if body.trim().is_empty() {
        return ViewState::default();
    }
    match serde_json::from_str::<ViewState>(&body) {
        Ok(state) => state,
        Err(e) => {
            tracing::warn!("view_state parse failed ({}): {e:#}", path.display());
            ViewState::default()
        }
    }
}

/// Atomically write view state to `<workspace>/view.json`. Returns an
/// error only on IO / serialization failure; the caller decides whether
/// to surface that or swallow it.
pub fn save(workspace: &Path, state: &ViewState) -> Result<()> {
    fs::create_dir_all(workspace)
        .with_context(|| format!("create {}", workspace.display()))?;
    let path = workspace.join(VIEW_FILE);
    let json = serde_json::to_string_pretty(state).context("serialize view state")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Filter to only the keys present in `live_ids`. Lets the saver drop
/// entries for tracks the user deleted so view.json doesn't grow
/// unbounded across a project lifetime.
pub fn prune_track_heights<'a, I>(heights: &mut TrackHeights, live_ids: I)
where
    I: IntoIterator<Item = &'a str>,
{
    let live: std::collections::HashSet<&str> = live_ids.into_iter().collect();
    heights.retain(|k, _| live.contains(k.as_str()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn defaults_when_no_file() {
        let tmp = TempDir::new().unwrap();
        let state = load(tmp.path());
        assert_eq!(state.timeline_px_per_sec, 80.0);
        assert!(state.track_heights.is_empty());
    }

    #[test]
    fn round_trip() {
        let tmp = TempDir::new().unwrap();
        let mut s = ViewState::default();
        s.timeline_px_per_sec = 200.0;
        s.track_heights.insert("t1".into(), 64);
        s.track_heights.insert("t2".into(), 96);
        save(tmp.path(), &s).unwrap();
        let loaded = load(tmp.path());
        assert!((loaded.timeline_px_per_sec - 200.0).abs() < f32::EPSILON);
        assert_eq!(loaded.track_heights.get("t1"), Some(&64));
        assert_eq!(loaded.track_heights.get("t2"), Some(&96));
    }

    #[test]
    fn tolerates_empty_file() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(VIEW_FILE), "").unwrap();
        let state = load(tmp.path());
        assert_eq!(state.timeline_px_per_sec, 80.0);
    }

    #[test]
    fn tolerates_garbage_file() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(VIEW_FILE), "{ not json").unwrap();
        // Should warn-and-default rather than propagate the error.
        let state = load(tmp.path());
        assert_eq!(state.timeline_px_per_sec, 80.0);
    }

    #[test]
    fn missing_fields_inherit_defaults() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(VIEW_FILE), "{}").unwrap();
        let state = load(tmp.path());
        assert_eq!(state.timeline_px_per_sec, 80.0);
        assert!(state.track_heights.is_empty());
    }

    #[test]
    fn expanded_tracks_round_trip_and_default() {
        let tmp = TempDir::new().unwrap();
        // missing field defaults to empty
        fs::write(tmp.path().join(VIEW_FILE), "{}").unwrap();
        assert!(load(tmp.path()).expanded_tracks.is_empty());
        // round-trips
        let mut s = ViewState::default();
        s.expanded_tracks = vec!["t1".into(), "t2".into()];
        save(tmp.path(), &s).unwrap();
        assert_eq!(load(tmp.path()).expanded_tracks, vec!["t1".to_string(), "t2".to_string()]);
    }

    #[test]
    fn prune_drops_dead_ids() {
        let mut heights = TrackHeights::new();
        heights.insert("alive".into(), 40);
        heights.insert("dead".into(), 90);
        prune_track_heights(&mut heights, ["alive"]);
        assert!(heights.contains_key("alive"));
        assert!(!heights.contains_key("dead"));
    }
}
