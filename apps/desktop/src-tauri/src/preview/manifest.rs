//! Preview manifest schema + atomic JSON persistence (Phase A2).
//!
//! One manifest per global state hash, written to
//! `<workspace>/Cache/preview/<global_hash>.manifest.json`. The manifest is
//! the *intent*: it lists every segment that should exist for this project
//! state, each carrying its content hash and a `pending|running|ready|
//! failed` status. Files reach the cache as their renders complete; the
//! React side tracks status via Tauri events.
//!
//! Path fields are intentionally OMITTED from the JSON. The cache layout
//! is the single source of truth — paths are derived from `global_hash` /
//! `segment.hash` via `cache::preview_segment` / `preview_init` /
//! `preview_audio`. Avoids stale-path drift if the workspace moves.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::cache::{discard_temp, promote_temp, temp_path};

/// Top-level manifest. One JSON file per global state hash.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub global_hash: String,
    pub duration_us: i64,
    pub canvas: CanvasParams,
    pub video: VideoTrack,
    pub audio: AudioTrack,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CanvasParams {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct VideoTrack {
    /// MSE codec string. Matches the segment encoder's output exactly —
    /// mismatched codec strings cause SourceBuffer.appendBuffer() to silently
    /// reject the bytes (decision M1 in `docs/preview-segmented-cache.md`).
    pub codec: String,
    pub segments: Vec<SegmentEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentEntry {
    pub in_us: i64,
    pub out_us: i64,
    /// Content hash. Dedup key — same content under any project state
    /// produces the same hash (see `preview::segment_hash`).
    pub hash: String,
    pub status: SegmentStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioTrack {
    pub codec: String,
    pub status: SegmentStatus,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SegmentStatus {
    /// Queued; render not yet started.
    Pending,
    /// ffmpeg child is currently producing this segment.
    Running,
    /// File on disk and `cached_ok` predicate passes.
    Ready,
    /// Render failed; see `LogBus` for details. Manual retry via the
    /// status-bar UI re-enqueues with this state cleared.
    Failed,
}

/// Atomic save: serialize to `<path>.tmp`, fsync via rename to `<path>`.
/// Mirrors the cache atomicity helpers in `cache::promote_temp`.
pub fn save_manifest(path: &Path, manifest: &Manifest) -> Result<()> {
    let tmp = temp_path(path);
    let body = serde_json::to_vec_pretty(manifest)
        .context("serialize manifest to json")?;
    // Best-effort cleanup of any prior `.tmp` left behind by a previous
    // crash before we write a fresh one.
    discard_temp(path);
    std::fs::write(&tmp, &body)
        .with_context(|| format!("write {}", tmp.display()))?;
    promote_temp(path)
}

/// Load + parse a manifest from disk. Returns `Ok(None)` if the file
/// doesn't exist (the common pre-render case); `Err` only on read /
/// parse failure. Treat `Ok(None)` as "no prior state — render
/// everything fresh".
pub fn load_manifest(path: &Path) -> Result<Option<Manifest>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let m: Manifest = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse manifest {}", path.display()))?;
            Ok(Some(m))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

/// Result of diffing two manifests. Segments are matched **by content hash**,
/// never by `(in_us, out_us)`. The load-bearing optimization: inserting a 2s
/// clip at t=5 shifts every later segment on the timeline but doesn't change
/// their content hashes — the diff reports 0 new segments and just re-times
/// the manifest entries.
///
/// Note: this is a pure function over manifests. It does NOT check the
/// filesystem to verify a "reused" segment's bytes are actually on disk.
/// The orchestrator runs `cache::cached_ok` at dispatch time and falls back
/// to enqueueing if the cache file is missing or zero-byte.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestDiff {
    /// Segments in `new` whose content hash is NOT in `old`. The orchestrator
    /// must enqueue an ffmpeg render for each.
    pub new_segments: Vec<SegmentEntry>,
    /// Segments in `new` whose content hash IS in `old`. Cache hit candidate —
    /// the orchestrator still re-verifies `cached_ok` before skipping.
    pub reused_segments: Vec<SegmentEntry>,
    /// Hashes in `old` that don't appear in `new`. Candidates for GC.
    pub obsolete_segments: Vec<String>,
    /// True when the global hash changed (or there's no prior manifest).
    /// Audio is whole-timeline keyed by global hash, so any global change
    /// invalidates the audio file.
    pub audio_changed: bool,
}

/// Diff `new` against `old`. Pass `None` for `old` when there's no prior
/// state (first render of a project, or first time this global hash exists).
pub fn diff_manifests(old: Option<&Manifest>, new: &Manifest) -> ManifestDiff {
    let old_hashes: std::collections::HashSet<&str> = match old {
        Some(o) => o.video.segments.iter().map(|s| s.hash.as_str()).collect(),
        None => std::collections::HashSet::new(),
    };
    let new_hashes: std::collections::HashSet<&str> =
        new.video.segments.iter().map(|s| s.hash.as_str()).collect();

    let mut new_segments = Vec::new();
    let mut reused_segments = Vec::new();
    for seg in &new.video.segments {
        if old_hashes.contains(seg.hash.as_str()) {
            reused_segments.push(seg.clone());
        } else {
            new_segments.push(seg.clone());
        }
    }

    let obsolete_segments: Vec<String> = match old {
        Some(o) => o
            .video
            .segments
            .iter()
            .filter(|s| !new_hashes.contains(s.hash.as_str()))
            .map(|s| s.hash.clone())
            .collect(),
        None => Vec::new(),
    };

    let audio_changed = match old {
        Some(o) => o.global_hash != new.global_hash,
        None => true,
    };

    ManifestDiff {
        new_segments,
        reused_segments,
        obsolete_segments,
        audio_changed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_manifest() -> Manifest {
        Manifest {
            global_hash: "global-abc".into(),
            duration_us: 10_000_000,
            canvas: CanvasParams {
                width: 1920,
                height: 1080,
                fps_num: 30,
                fps_den: 1,
            },
            video: VideoTrack {
                codec: "avc1.640028".into(),
                segments: vec![
                    SegmentEntry {
                        in_us: 0,
                        out_us: 5_000_000,
                        hash: "seg-11".into(),
                        status: SegmentStatus::Ready,
                    },
                    SegmentEntry {
                        in_us: 5_000_000,
                        out_us: 10_000_000,
                        hash: "seg-22".into(),
                        status: SegmentStatus::Pending,
                    },
                ],
            },
            audio: AudioTrack {
                codec: "mp4a.40.2".into(),
                status: SegmentStatus::Pending,
            },
        }
    }

    #[test]
    fn roundtrip_save_then_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.manifest.json");
        let m = sample_manifest();
        save_manifest(&path, &m).expect("save");
        let loaded = load_manifest(&path).expect("load").expect("present");
        assert_eq!(loaded, m);
    }

    #[test]
    fn save_is_atomic_and_overwrites() {
        // Write twice in a row; second write replaces first cleanly. No
        // `.tmp` artifact is left behind.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.manifest.json");
        let mut m = sample_manifest();
        save_manifest(&path, &m).unwrap();
        m.global_hash = "global-DIFFERENT".into();
        save_manifest(&path, &m).unwrap();
        let loaded = load_manifest(&path).unwrap().unwrap();
        assert_eq!(loaded.global_hash, "global-DIFFERENT");
        assert!(!temp_path(&path).exists(), ".tmp must not remain on disk");
    }

    #[test]
    fn load_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nope.manifest.json");
        assert!(load_manifest(&path).unwrap().is_none());
    }

    #[test]
    fn load_malformed_returns_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.manifest.json");
        std::fs::write(&path, b"not valid json").unwrap();
        assert!(load_manifest(&path).is_err());
    }

    fn seg(in_us: i64, out_us: i64, hash: &str) -> SegmentEntry {
        SegmentEntry {
            in_us,
            out_us,
            hash: hash.into(),
            status: SegmentStatus::Pending,
        }
    }

    fn manifest_with(global_hash: &str, segments: Vec<SegmentEntry>) -> Manifest {
        Manifest {
            global_hash: global_hash.into(),
            duration_us: segments.last().map(|s| s.out_us).unwrap_or(0),
            canvas: CanvasParams {
                width: 1920,
                height: 1080,
                fps_num: 30,
                fps_den: 1,
            },
            video: VideoTrack {
                codec: "avc1.640028".into(),
                segments,
            },
            audio: AudioTrack {
                codec: "mp4a.40.2".into(),
                status: SegmentStatus::Pending,
            },
        }
    }

    #[test]
    fn diff_identity_has_no_new_or_obsolete() {
        let m = manifest_with(
            "global-1",
            vec![seg(0, 5_000_000, "a"), seg(5_000_000, 10_000_000, "b")],
        );
        let d = diff_manifests(Some(&m), &m);
        assert!(d.new_segments.is_empty());
        assert!(d.obsolete_segments.is_empty());
        assert_eq!(d.reused_segments.len(), 2);
        assert!(!d.audio_changed);
    }

    #[test]
    fn diff_no_prior_treats_everything_as_new() {
        let m = manifest_with("global-1", vec![seg(0, 5_000_000, "a")]);
        let d = diff_manifests(None, &m);
        assert_eq!(d.new_segments.len(), 1);
        assert_eq!(d.new_segments[0].hash, "a");
        assert!(d.reused_segments.is_empty());
        assert!(d.obsolete_segments.is_empty());
        assert!(d.audio_changed);
    }

    #[test]
    fn diff_clip_shift_reports_zero_new_segments() {
        // The load-bearing test: same content hashes at different positions
        // produce 0 new and 0 obsolete.
        let old = manifest_with(
            "global-1",
            vec![seg(0, 5_000_000, "a"), seg(5_000_000, 10_000_000, "b")],
        );
        // Insert a 2s clip at t=0: every segment shifts by 2s but their
        // content hashes stay the same.
        let new = manifest_with(
            "global-2", // global hash changes (timeline duration changed)
            vec![
                seg(0, 2_000_000, "c"),                // the new prefix clip
                seg(2_000_000, 7_000_000, "a"),        // shifted "a"
                seg(7_000_000, 12_000_000, "b"),       // shifted "b"
            ],
        );
        let d = diff_manifests(Some(&old), &new);
        // Only the new prefix clip is new; "a" and "b" are reused.
        assert_eq!(d.new_segments.len(), 1);
        assert_eq!(d.new_segments[0].hash, "c");
        assert_eq!(d.reused_segments.len(), 2);
        assert_eq!(d.obsolete_segments.len(), 0);
        // global hash changed → audio invalidated.
        assert!(d.audio_changed);
    }

    #[test]
    fn diff_content_change_invalidates_one_segment() {
        let old = manifest_with(
            "global-1",
            vec![seg(0, 5_000_000, "a"), seg(5_000_000, 10_000_000, "b")],
        );
        // User edited within [5,10] — "b" hashes to "b2" now.
        let new = manifest_with(
            "global-2",
            vec![seg(0, 5_000_000, "a"), seg(5_000_000, 10_000_000, "b2")],
        );
        let d = diff_manifests(Some(&old), &new);
        assert_eq!(d.new_segments.len(), 1);
        assert_eq!(d.new_segments[0].hash, "b2");
        assert_eq!(d.reused_segments.len(), 1);
        assert_eq!(d.reused_segments[0].hash, "a");
        assert_eq!(d.obsolete_segments, vec!["b".to_string()]);
    }

    #[test]
    fn diff_timeline_lengthened_adds_segments() {
        let old = manifest_with("global-1", vec![seg(0, 5_000_000, "a")]);
        let new = manifest_with(
            "global-2",
            vec![seg(0, 5_000_000, "a"), seg(5_000_000, 10_000_000, "b")],
        );
        let d = diff_manifests(Some(&old), &new);
        assert_eq!(d.new_segments.len(), 1);
        assert_eq!(d.new_segments[0].hash, "b");
        assert_eq!(d.reused_segments.len(), 1);
        assert!(d.obsolete_segments.is_empty());
    }

    #[test]
    fn diff_audio_changed_only_when_global_hash_differs() {
        let a = manifest_with("global-1", vec![seg(0, 5_000_000, "x")]);
        let b = manifest_with("global-1", vec![seg(0, 5_000_000, "x")]);
        assert!(!diff_manifests(Some(&a), &b).audio_changed);

        let c = manifest_with("global-DIFFERENT", vec![seg(0, 5_000_000, "x")]);
        assert!(diff_manifests(Some(&a), &c).audio_changed);
    }

    #[test]
    fn segment_status_json_is_snake_case() {
        // Stable wire format — these strings are part of the on-disk and
        // event-payload contract. Don't let a refactor accidentally
        // change them.
        assert_eq!(
            serde_json::to_string(&SegmentStatus::Pending).unwrap(),
            "\"pending\""
        );
        assert_eq!(
            serde_json::to_string(&SegmentStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&SegmentStatus::Ready).unwrap(),
            "\"ready\""
        );
        assert_eq!(
            serde_json::to_string(&SegmentStatus::Failed).unwrap(),
            "\"failed\""
        );
    }
}
