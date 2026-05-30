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
/// Largest keyframe interval (seconds) a source may have and still scrub
/// acceptably when decoded directly. Beyond this, a mid-GOP seek must decode
/// too many frames from its keyframe (the freeze/churn the editor avoids), so
/// the source is routed to a short-GOP scrub proxy instead of bypassed. ~0.5 s
/// keeps a backward seek's decode bounded to a fraction of a second.
const MAX_BYPASS_GOP_SECONDS: f64 = 0.5;
const DIRECT_FULL_MAX_DURATION_US: i64 = 10_000_000;
const DIRECT_FULL_MAX_SIZE_BYTES: u64 = 150 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportSource {
    /// WebCodecs can decode the original on this machine; export reads it.
    Original,
    /// Original isn't directly decodable here; export reads the full proxy.
    FullProxy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreviewSource {
    /// The original scrubs acceptably; preview reads it directly.
    Original,
    /// Original is heavy / long-GOP / undecodable; preview reads a proxy (the
    /// quick scrub proxy, or the full proxy for small undecodable sources).
    Proxy,
}

/// Per-source routing: two independent axes.
///
/// Invariant: `preview == Original` implies `export == Original`. The only
/// path to preview-from-original is `source_is_safe_to_bypass`, which requires
/// H.264 + a browser-friendly pixfmt -- a strict subset of the condition for
/// `decodable_directly`. Hence `{ FullProxy, Original }` is unreachable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProxyRoute {
    pub export: ExportSource,
    pub preview: PreviewSource,
}

/// Which background proxy job(s) a route implies, given whether the source is
/// small enough to skip the fast phase. Pure policy, unit-tested in isolation
/// so the `is_small` scheduling split keeps the coverage the flat `ProxyPlan`
/// used to carry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyJob {
    /// No proxy: bypass. Preview + export both read the original.
    None,
    /// Standalone quick scrub proxy; export reads the original (DirectExport).
    QuickOnly,
    /// Full proxy directly, no quick phase (small undecodable source).
    FullOnly,
    /// Quick proxy first, then the full proxy in the background.
    QuickThenFull,
}

/// Route an imported source onto the two axes. `source_gop_secs` is the
/// source's largest keyframe interval (`probe::probe_max_keyframe_gap_secs`),
/// or `None` if unknown.
pub fn decide(media: &MediaItem, source_gop_secs: Option<f64>) -> ProxyRoute {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyRoute {
            export: ExportSource::Original,
            preview: PreviewSource::Original,
        };
    }
    let export = if export_decodable_statically(media) {
        ExportSource::Original
    } else {
        ExportSource::FullProxy
    };
    let preview = if source_is_safe_to_bypass(media, source_gop_secs) {
        PreviewSource::Original
    } else {
        PreviewSource::Proxy
    };
    ProxyRoute { export, preview }
}

/// Map a route + small-source flag to the background job to run.
pub fn job_for(route: ProxyRoute, is_small: bool) -> ProxyJob {
    match (route.export, route.preview) {
        (ExportSource::Original, PreviewSource::Original) => ProxyJob::None,
        (ExportSource::Original, PreviewSource::Proxy) => ProxyJob::QuickOnly,
        (ExportSource::FullProxy, PreviewSource::Proxy) => {
            if is_small {
                ProxyJob::FullOnly
            } else {
                ProxyJob::QuickThenFull
            }
        }
        (ExportSource::FullProxy, PreviewSource::Original) => {
            unreachable!("preview=Original implies export=Original (safe_to_bypass is a subset of decodable_directly)")
        }
    }
}

/// A source WebCodecs can decode at export **in principle**, independent of
/// this machine: an 8-bit browser-friendly pixel format and a codec in the
/// WebCodecs family. The actual machine is confirmed by the export pre-flight
/// (`probeSourceDecodable`), not here. VP8 is intentionally excluded (no
/// `codec_is_vp8` helper; effectively extinct) — it routes to a full proxy.
fn export_decodable_statically(media: &MediaItem) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    if !pix_fmt_is_browser_friendly(&video.pix_fmt) {
        return false;
    }
    let codec = video.codec.to_ascii_lowercase();
    codec_is_h264(&codec)
        || codec_is_hevc(&codec)
        || codec_is_av1(&codec)
        || codec_is_vp9(&codec)
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

/// True when a source's GOP is KNOWN to be short enough to scrub directly.
/// `None` (probe failed) is treated as NOT friendly: an unknown GOP may be
/// long, and a mis-bypassed long-GOP original freezes on backward scrub with
/// no recovery (preview reads the original; no proxy is ever generated). The
/// graceful failure is to generate a scrub proxy on a probe hiccup. Shared
/// with `quick_proxy::can_remux`, where the same flip means an unknown-GOP
/// source is transcoded to a short GOP rather than remuxed (remux would carry
/// the unknown GOP through).
pub fn gop_is_scrub_friendly(source_gop_secs: Option<f64>) -> bool {
    source_gop_secs.map_or(false, |g| g <= MAX_BYPASS_GOP_SECONDS)
}

pub fn is_small_source(media: &MediaItem) -> bool {
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

    const BOTH_ORIGINAL: ProxyRoute = ProxyRoute {
        export: ExportSource::Original,
        preview: PreviewSource::Original,
    };
    const EXPORT_ORIGINAL_PREVIEW_PROXY: ProxyRoute = ProxyRoute {
        export: ExportSource::Original,
        preview: PreviewSource::Proxy,
    };
    const BOTH_PROXY: ProxyRoute = ProxyRoute {
        export: ExportSource::FullProxy,
        preview: PreviewSource::Proxy,
    };

    // --- decide(): two-axis routing oracle (no machine caps) ---

    #[test]
    fn direct_both_for_friendly_h264_1080p() {
        assert_eq!(decide(&video(|_| {}), Some(0.2)), BOTH_ORIGINAL);
    }

    #[test]
    fn long_gop_friendly_h264_previews_from_proxy() {
        assert_eq!(decide(&video(|_| {}), Some(6.0)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn unknown_gop_previews_from_proxy() {
        // None-GOP fix (Piece A): unknown gap → preview proxy, export still original.
        assert_eq!(decide(&video(|_| {}), None), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn four_k_h264_exports_original_previews_proxy() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn hevc_8bit_exports_original_previews_proxy() {
        // No caps needed any more: a family codec (HEVC) 8-bit is export-decodable
        // *statically*; the export pre-flight confirms the actual machine.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn av1_8bit_exports_original_previews_proxy() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "av01".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn vp9_8bit_exports_original_previews_proxy() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "vp09".into();
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn non_family_codec_proxies_both() {
        // ProRes / MPEG-2 etc. are not WebCodecs-decodable on any machine → full proxy.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "prores".into();
        });
        assert_eq!(decide(&item, Some(0.2)), BOTH_PROXY);
    }

    #[test]
    fn hevc_10bit_proxies_both() {
        // 10-bit pixfmt is not browser-friendly → full proxy regardless of codec.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.pix_fmt = "yuv420p10le".into();
        });
        assert_eq!(decide(&item, Some(0.2)), BOTH_PROXY);
    }

    #[test]
    fn non_video_routes_to_both_original() {
        let item = video(|m| {
            m.kind = MediaKind::Audio;
        });
        assert_eq!(decide(&item, Some(6.0)), BOTH_ORIGINAL);
    }

    // --- job_for(): scheduling oracle (the is_small split) — unchanged ---

    #[test]
    fn job_none_for_both_original() {
        assert_eq!(job_for(BOTH_ORIGINAL, false), ProxyJob::None);
        assert_eq!(job_for(BOTH_ORIGINAL, true), ProxyJob::None);
    }

    #[test]
    fn job_quick_only_for_direct_export() {
        assert_eq!(job_for(EXPORT_ORIGINAL_PREVIEW_PROXY, false), ProxyJob::QuickOnly);
        assert_eq!(job_for(EXPORT_ORIGINAL_PREVIEW_PROXY, true), ProxyJob::QuickOnly);
    }

    #[test]
    fn job_full_only_for_small_proxy_both() {
        assert_eq!(job_for(BOTH_PROXY, true), ProxyJob::FullOnly);
    }

    #[test]
    fn job_quick_then_full_for_large_proxy_both() {
        assert_eq!(job_for(BOTH_PROXY, false), ProxyJob::QuickThenFull);
    }
}
