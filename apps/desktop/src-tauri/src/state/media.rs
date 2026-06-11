//! Imported source media. The media pool is content-addressed by blake3 so
//! relink-by-content works when files move.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ids::MediaId;
use super::time::TimeUs;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: MediaId,
    pub label: Option<String>,
    pub path_abs: PathBuf,
    pub path_rel: Option<PathBuf>,
    pub kind: MediaKind,
    pub metadata: MediaMetadata,
    pub proxy_path: Option<PathBuf>,
    /// Format-version of the cached proxy at `proxy_path` — compared
    /// against `jobs::proxy::PROXY_FORMAT_VERSION` on workspace open
    /// to invalidate stale proxies. See `docs/preview.md`.
    /// `#[serde(default)]` keeps older `.vproj` files loadable as
    /// version 0.
    #[serde(default)]
    pub proxy_format_version: u32,
    /// Fast preview-first proxy produced before the full proxy is ready.
    /// Preview may use this; export must ignore it.
    #[serde(default)]
    pub quick_proxy_path: Option<PathBuf>,
    /// True when the original workspace copy is safe enough for direct
    /// WebCodecs use and no generated proxy is required.
    #[serde(default)]
    pub proxy_bypassed: bool,
    /// True when the export path may decode the ORIGINAL workspace copy
    /// directly (WebCodecs can decode it) even though a preview proxy is
    /// still generated for scrubbing. Distinct from `proxy_bypassed`, which
    /// means *no proxy at all* (original for preview AND export).
    #[serde(default)]
    pub export_uses_original: bool,
    pub waveform_path: Option<PathBuf>,
    /// Canonical conformed PCM (VCONF; see `jobs::conform`). `None` until
    /// the conform job lands. Serde-defaulted so pre-conform projects load.
    #[serde(default)]
    pub conform_path: Option<PathBuf>,
    pub thumbnails_dir: Option<PathBuf>,
    pub file_hash_blake3: String,
    pub file_size: u64,
    pub file_mtime: u64,
    pub imported_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MediaKind {
    Video,
    Audio,
    Image,
    Subtitle,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub duration_us: Option<TimeUs>,
    pub video: Option<VideoStreamMeta>,
    pub audio: Option<AudioStreamMeta>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VideoStreamMeta {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub codec: String,
    pub pix_fmt: String,
    /// Demuxer-reported frame count (ffprobe `nb_frames`), when the container
    /// carries one. `Some(1)` marks a single-frame stream — how `detect_kind`
    /// tells a still image from an animated GIF. `None` when the demuxer
    /// doesn't report it (common for png/webp pipes and many mp4s).
    #[serde(default)]
    pub nb_frames: Option<u64>,
    /// Color tags from the container/bitstream (ffprobe names). `color_matrix`
    /// corresponds to ffprobe's `color_space` key (YCbCr matrix coefficients,
    /// e.g. "bt709", "smpte170m") — named `matrix` here to avoid conflation with
    /// the broader "color space" concept; `color_range` is "tv"/"pc";
    /// `color_primaries`/`color_transfer` follow ffprobe naming directly. `None`
    /// when the source declares no value (or declares "unknown").
    #[serde(default)]
    pub color_matrix: Option<String>,
    #[serde(default)]
    pub color_range: Option<String>,
    #[serde(default)]
    pub color_primaries: Option<String>,
    #[serde(default)]
    pub color_transfer: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioStreamMeta {
    pub sample_rate: u32,
    pub channels: u8,
    pub codec: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_uses_original_defaults_false_for_old_projects() {
        // A `.vproj` MediaItem written before this field existed must load
        // as `export_uses_original: false`.
        let json = r#"{
            "id": "00000000-0000-0000-0000-000000000000",
            "label": null,
            "path_abs": "clip.mp4",
            "path_rel": null,
            "kind": "Video",
            "metadata": { "duration_us": null, "video": null, "audio": null },
            "proxy_path": null,
            "quick_proxy_path": null,
            "proxy_bypassed": true,
            "waveform_path": null,
            "thumbnails_dir": null,
            "file_hash_blake3": "abc",
            "file_size": 1,
            "file_mtime": 0,
            "imported_at": "2026-05-29T00:00:00Z"
        }"#;
        let item: MediaItem = serde_json::from_str(json).unwrap();
        assert!(!item.export_uses_original);
        assert!(item.proxy_bypassed);
    }
}
