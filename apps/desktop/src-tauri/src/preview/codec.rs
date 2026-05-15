//! Per-platform codec profile for the segmented preview cache (Phase A6).
//!
//! Picks the codec set that matches what the local WebView's MSE
//! implementation can decode:
//!   * **Windows + macOS** → H.264 High@L4.0 + AAC-LC in fMP4. WebView2
//!     and WKWebView both have rock-solid support; matches what
//!     ffmpeg's HW encoders (NVENC / QSV / AMF / VideoToolbox) produce.
//!   * **Linux** → VP9 + Opus in WebM. Some distros (Fedora classic,
//!     RHEL, anything fully-libre by default) ship WebKitGTK without
//!     `gstreamer1.0-libav` for H.264 licensing reasons — VP9 plays
//!     natively without an extra plugin install. Hardware encode is
//!     less ubiquitous than H.264, so we accept software speed there.
//!
//! Both branches keep the same flat segments dir + manifest schema —
//! only the bytes inside differ. Extensions stay `.m4s` / `.m4a`
//! regardless of container; MSE consumes by codec string, not filename.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CodecProfile {
    /// H.264 High@L4.0 + AAC-LC, fMP4 container.
    H264Mp4,
    /// VP9 Profile 0 + Opus, WebM container.
    Vp9Webm,
}

impl CodecProfile {
    /// Best codec profile for the current build's target OS.
    pub fn default_for_platform() -> Self {
        if cfg!(target_os = "linux") {
            Self::Vp9Webm
        } else {
            Self::H264Mp4
        }
    }

    /// MSE-shape video codec string (the part inside `codecs="..."`).
    pub fn video_codec_string(self) -> &'static str {
        match self {
            // H.264 High profile, Level 4.0
            Self::H264Mp4 => "avc1.640028",
            // VP9 Profile 0, Level 4, BitDepth 8 — covers 1080p30 and
            // 1080p60. The full RFC6381 codec string is
            // `vp09.00.41.08.01.01.01.01.00` but most browsers accept
            // the abbreviated form.
            Self::Vp9Webm => "vp09.00.41.08",
        }
    }

    pub fn audio_codec_string(self) -> &'static str {
        match self {
            Self::H264Mp4 => "mp4a.40.2",
            Self::Vp9Webm => "opus",
        }
    }

    /// MSE SourceBuffer mime prefix (`video/mp4` vs `video/webm` etc.).
    /// Combined with the codec string the React side builds the full
    /// addSourceBuffer mime.
    pub fn video_mime_prefix(self) -> &'static str {
        match self {
            Self::H264Mp4 => "video/mp4",
            Self::Vp9Webm => "video/webm",
        }
    }

    pub fn audio_mime_prefix(self) -> &'static str {
        match self {
            Self::H264Mp4 => "audio/mp4",
            Self::Vp9Webm => "audio/webm",
        }
    }

    /// ffmpeg `-f` muxer name.
    pub fn ffmpeg_format(self) -> &'static str {
        match self {
            Self::H264Mp4 => "mp4",
            Self::Vp9Webm => "webm",
        }
    }
}

impl Default for CodecProfile {
    fn default() -> Self {
        Self::default_for_platform()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_strings_are_stable_wire_contract() {
        // These strings are part of the MSE wire contract — a mismatch
        // silently rejects appendBuffer() bytes. Catches an accidental
        // edit drifting from `avc1.640028` (H.264 High@L4.0) or
        // `vp09.00.41.08` (VP9 P0 L4 BD8).
        assert_eq!(CodecProfile::H264Mp4.video_codec_string(), "avc1.640028");
        assert_eq!(CodecProfile::H264Mp4.audio_codec_string(), "mp4a.40.2");
        assert_eq!(CodecProfile::Vp9Webm.video_codec_string(), "vp09.00.41.08");
        assert_eq!(CodecProfile::Vp9Webm.audio_codec_string(), "opus");
    }

    #[test]
    fn mime_prefix_matches_container() {
        assert_eq!(CodecProfile::H264Mp4.video_mime_prefix(), "video/mp4");
        assert_eq!(CodecProfile::H264Mp4.audio_mime_prefix(), "audio/mp4");
        assert_eq!(CodecProfile::Vp9Webm.video_mime_prefix(), "video/webm");
        assert_eq!(CodecProfile::Vp9Webm.audio_mime_prefix(), "audio/webm");
    }

    #[test]
    fn ffmpeg_format_matches_container() {
        assert_eq!(CodecProfile::H264Mp4.ffmpeg_format(), "mp4");
        assert_eq!(CodecProfile::Vp9Webm.ffmpeg_format(), "webm");
    }

    #[test]
    fn default_picks_linux_vp9() {
        // Compile-time check: ON LINUX builds the default is Vp9Webm;
        // on Win/Mac it's H264Mp4. We can only verify the current host's
        // branch here.
        let default = CodecProfile::default_for_platform();
        if cfg!(target_os = "linux") {
            assert_eq!(default, CodecProfile::Vp9Webm);
        } else {
            assert_eq!(default, CodecProfile::H264Mp4);
        }
    }
}
