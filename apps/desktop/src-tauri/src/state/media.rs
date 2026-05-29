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
    /// to invalidate stale proxies. See `docs/preview-scrub.md`.
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
    pub waveform_path: Option<PathBuf>,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioStreamMeta {
    pub sample_rate: u32,
    pub channels: u8,
    pub codec: String,
}
