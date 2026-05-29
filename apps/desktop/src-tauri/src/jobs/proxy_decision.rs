//! Cheap proxy-routing policy for imported video.
//!
//! This is intentionally conservative. A source is bypassed only when it is
//! already close to the editor's proxy contract: H.264, <=1080p, 8-bit
//! browser-friendly pixel format, and moderate bitrate. Everything else gets
//! a generated proxy path so scrub/decode behavior stays predictable.

use crate::state::{MediaItem, MediaKind};

const MAX_BYPASS_WIDTH: u32 = 1920;
const MAX_BYPASS_HEIGHT: u32 = 1080;
const MAX_BYPASS_BITRATE_BPS: u64 = 25_000_000;
const DIRECT_FULL_MAX_DURATION_US: i64 = 10_000_000;
const DIRECT_FULL_MAX_SIZE_BYTES: u64 = 150 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyDecision {
    /// Use the workspace copy directly; no proxy job needed.
    Bypass,
    /// Generate the existing full-quality proxy directly.
    FullProxyOnly,
    /// Generate a fast preview proxy first, then the full proxy in the
    /// background.
    QuickProxyThenFull,
}

pub fn decide(media: &MediaItem) -> ProxyDecision {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyDecision::Bypass;
    }
    if source_is_safe_to_bypass(media) {
        return ProxyDecision::Bypass;
    }
    if is_small_source(media) {
        return ProxyDecision::FullProxyOnly;
    }
    ProxyDecision::QuickProxyThenFull
}

fn source_is_safe_to_bypass(media: &MediaItem) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    if !codec_is_h264(&video.codec) {
        return false;
    }
    if video.width > MAX_BYPASS_WIDTH || video.height > MAX_BYPASS_HEIGHT {
        return false;
    }
    if !pix_fmt_is_browser_friendly(&video.pix_fmt) {
        return false;
    }
    if estimated_bitrate_bps(media) > Some(MAX_BYPASS_BITRATE_BPS) {
        return false;
    }
    true
}

fn is_small_source(media: &MediaItem) -> bool {
    media
        .metadata
        .duration_us
        .map(|d| d > 0 && d <= DIRECT_FULL_MAX_DURATION_US)
        .unwrap_or(false)
        && media.file_size <= DIRECT_FULL_MAX_SIZE_BYTES
}

pub fn codec_is_h264(codec: &str) -> bool {
    let c = codec.to_ascii_lowercase();
    matches!(c.as_str(), "h264" | "avc1" | "avc")
}

pub fn pix_fmt_is_browser_friendly(pix_fmt: &str) -> bool {
    let p = pix_fmt.to_ascii_lowercase();
    matches!(p.as_str(), "yuv420p" | "nv12")
}

fn estimated_bitrate_bps(media: &MediaItem) -> Option<u64> {
    let duration_us = media.metadata.duration_us?;
    if duration_us <= 0 {
        return None;
    }
    let bits = u128::from(media.file_size) * 8 * 1_000_000;
    Some((bits / duration_us as u128) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{new_id, MediaKind, MediaMetadata, VideoStreamMeta};
    use chrono::Utc;

    fn video(over: impl FnOnce(&mut MediaItem)) -> MediaItem {
        let mut item = MediaItem {
            id: new_id(),
            label: None,
            path_abs: "clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width: 1920,
                    height: 1080,
                    fps_num: 30,
                    fps_den: 1,
                    codec: "h264".into(),
                    pix_fmt: "yuv420p".into(),
                }),
                audio: None,
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 10_000_000,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        over(&mut item);
        item
    }

    #[test]
    fn bypasses_friendly_h264_1080p() {
        assert_eq!(decide(&video(|_| {})), ProxyDecision::Bypass);
    }

    #[test]
    fn quick_proxy_for_large_hevc() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item), ProxyDecision::QuickProxyThenFull);
    }

    #[test]
    fn full_proxy_for_small_non_bypass_source() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.file_size = 10_000_000;
        });
        assert_eq!(decide(&item), ProxyDecision::FullProxyOnly);
    }
}
