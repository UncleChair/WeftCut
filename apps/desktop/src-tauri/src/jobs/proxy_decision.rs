//! Cheap proxy-routing policy for imported video.
//!
//! This is intentionally conservative. A source is bypassed only when it is
//! already close to the editor's proxy contract: H.264, <=1080p, 8-bit
//! browser-friendly pixel format, and moderate bitrate. Everything else gets
//! a generated proxy path so scrub/decode behavior stays predictable.

use crate::decode_caps::DecodeCaps;
use crate::state::{MediaItem, MediaKind};

const MAX_BYPASS_WIDTH: u32 = 1920;
const MAX_BYPASS_HEIGHT: u32 = 1080;
const MAX_BYPASS_BITRATE_BPS: u64 = 25_000_000;
/// Largest keyframe interval (seconds) a source may have and still scrub
/// acceptably when decoded directly. Beyond this, a mid-GOP seek must decode
/// too many frames from its keyframe (the freeze/churn the editor avoids), so
/// the source is routed to a short-GOP scrub proxy instead of bypassed. ~0.5 s
/// keeps a backward seek's decode bounded to a fraction of a second.
const MAX_BYPASS_GOP_SECONDS: f64 = 0.5;
const DIRECT_FULL_MAX_DURATION_US: i64 = 10_000_000;
const DIRECT_FULL_MAX_SIZE_BYTES: u64 = 150 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyPlan {
    /// No proxy. The workspace copy is used directly for BOTH preview and
    /// export. (Formerly `Bypass`.)
    DirectBoth,
    /// Export decodes the original directly; a fast preview proxy is
    /// generated for scrubbing only. No full proxy is produced.
    DirectExportQuickPreview,
    /// Small source: skip the fast phase, generate the full proxy directly.
    FullProxyOnly,
    /// Fast preview proxy first, then the full proxy in the background.
    QuickThenFull,
}

/// `source_gop_secs` is the source's largest keyframe interval in seconds
/// (`probe::probe_max_keyframe_gap_secs`), or `None` if unknown. A long GOP
/// blocks the full DirectBoth bypass — the source still needs a short-GOP
/// scrub proxy even though export could decode it directly.
pub fn decide(media: &MediaItem, caps: &DecodeCaps, source_gop_secs: Option<f64>) -> ProxyPlan {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyPlan::DirectBoth;
    }
    if source_is_safe_to_bypass(media, source_gop_secs) {
        return ProxyPlan::DirectBoth;
    }
    if decodable_directly(media, caps) {
        return ProxyPlan::DirectExportQuickPreview;
    }
    if is_small_source(media) {
        return ProxyPlan::FullProxyOnly;
    }
    ProxyPlan::QuickThenFull
}

/// A source WebCodecs can decode on THIS machine without a proxy. H.264 is
/// universal; HEVC/AV1/VP9 are gated by the webview probe (`DecodeCaps`).
/// Requires an 8-bit browser-friendly pixel format either way — 10-bit/HDR
/// stays carved out to a proxy (the render+encode path is 8-bit). Resolution
/// and bitrate don't matter here: they affect *scrub* comfort (the preview
/// proxy's job), not whether the export decoder can read the original.
fn decodable_directly(media: &MediaItem, caps: &DecodeCaps) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    if !pix_fmt_is_browser_friendly(&video.pix_fmt) {
        return false;
    }
    let codec = video.codec.to_ascii_lowercase();
    if codec_is_h264(&codec) {
        return true;
    }
    if codec_is_hevc(&codec) {
        return caps.hevc;
    }
    if codec_is_av1(&codec) {
        return caps.av1;
    }
    if codec_is_vp9(&codec) {
        return caps.vp9;
    }
    false
}

fn source_is_safe_to_bypass(media: &MediaItem, source_gop_secs: Option<f64>) -> bool {
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
    if !gop_is_scrub_friendly(source_gop_secs) {
        return false;
    }
    true
}

/// True when a source's GOP is short enough to scrub directly (or unknown).
/// `None` (probe failed) is treated as friendly so a probe hiccup never
/// regresses fast-import bypass — only a KNOWN-long GOP demotes the source.
/// Shared with `quick_proxy::can_remux` so a long-GOP source is transcoded to
/// a short GOP rather than remuxed (which would carry the long GOP through).
pub fn gop_is_scrub_friendly(source_gop_secs: Option<f64>) -> bool {
    source_gop_secs.map_or(true, |g| g <= MAX_BYPASS_GOP_SECONDS)
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

pub fn codec_is_hevc(codec: &str) -> bool {
    matches!(
        codec.to_ascii_lowercase().as_str(),
        "hevc" | "h265" | "hvc1" | "hev1"
    )
}

pub fn codec_is_av1(codec: &str) -> bool {
    matches!(codec.to_ascii_lowercase().as_str(), "av1" | "av01")
}

pub fn codec_is_vp9(codec: &str) -> bool {
    matches!(codec.to_ascii_lowercase().as_str(), "vp9" | "vp09")
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
    use crate::decode_caps::DecodeCaps;
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
            export_uses_original: false,
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
    fn direct_both_for_friendly_h264_1080p() {
        assert_eq!(
            decide(&video(|_| {}), &DecodeCaps::none(), Some(0.2)),
            ProxyPlan::DirectBoth
        );
    }

    #[test]
    fn long_gop_friendly_h264_is_not_direct_both() {
        // Friendly H.264 1080p that WOULD bypass — but a ~6 s GOP makes it
        // scrub terribly when decoded directly, so it must instead get a
        // short-GOP scrub proxy (export still decodes the original directly).
        assert_eq!(
            decide(&video(|_| {}), &DecodeCaps::none(), Some(6.0)),
            ProxyPlan::DirectExportQuickPreview
        );
        // Unknown GOP (probe failed) preserves fast-import bypass.
        assert_eq!(
            decide(&video(|_| {}), &DecodeCaps::none(), None),
            ProxyPlan::DirectBoth
        );
    }

    #[test]
    fn direct_export_for_4k_h264_without_caps() {
        // 4K H.264 is decodable on any machine — no probe needed.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(
            decide(&item, &DecodeCaps::none(), Some(0.2)),
            ProxyPlan::DirectExportQuickPreview
        );
    }

    #[test]
    fn direct_export_for_high_bitrate_h264_1080p() {
        // 1080p H.264 but ~40 Mbps (over the 25 Mbps bypass ceiling).
        let item = video(|m| {
            m.metadata.duration_us = Some(10_000_000);
            m.file_size = 50 * 1024 * 1024;
        });
        assert_eq!(
            decide(&item, &DecodeCaps::none(), Some(0.2)),
            ProxyPlan::DirectExportQuickPreview
        );
    }

    #[test]
    fn full_proxy_for_small_non_decodable_source() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.file_size = 10_000_000;
        });
        assert_eq!(decide(&item, &DecodeCaps::none(), Some(0.2)), ProxyPlan::FullProxyOnly);
    }

    #[test]
    fn hevc_is_proxy_both_without_caps() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, &DecodeCaps::none(), Some(0.2)), ProxyPlan::QuickThenFull);
    }

    #[test]
    fn hevc_is_direct_export_when_caps_allow() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        let caps = DecodeCaps {
            hevc: true,
            ..Default::default()
        };
        assert_eq!(
            decide(&item, &caps, Some(0.2)),
            ProxyPlan::DirectExportQuickPreview
        );
    }

    #[test]
    fn hevc_10bit_stays_proxy_even_with_caps() {
        // 10-bit is not browser-friendly → carve-out regardless of caps.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.pix_fmt = "yuv420p10le".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        let caps = DecodeCaps {
            hevc: true,
            ..Default::default()
        };
        assert_eq!(decide(&item, &caps, Some(0.2)), ProxyPlan::QuickThenFull);
    }

    #[test]
    fn av1_gated_by_caps() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "av01".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, &DecodeCaps::none(), Some(0.2)), ProxyPlan::QuickThenFull);
        let caps = DecodeCaps {
            av1: true,
            ..Default::default()
        };
        assert_eq!(
            decide(&item, &caps, Some(0.2)),
            ProxyPlan::DirectExportQuickPreview
        );
    }
}
