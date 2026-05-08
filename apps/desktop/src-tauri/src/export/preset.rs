//! Export presets. Each preset chooses encoder, container, codec params, and
//! audio settings. `apply_to_command` mutates the in-flight `tokio::Command`
//! to match. Hardware encoders are picked at the call site (not the preset)
//! so a single preset can emit hwaccel'd or software-only commands depending
//! on what the host supports.
//!
//! Adding a preset is intentionally low-ceremony — extend the enum, fill in
//! the `match` arms in `apply_to_command` and `recommended_extension`.

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::hwencoder::HwEncoder;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportPreset {
    /// 1080p H.264 + AAC MP4 — the universal target.
    H264Mp4_1080p,
    /// 4K H.264 + AAC MP4. Same codec as 1080p, lower CRF and the source
    /// graph is expected to render at 3840x2160 (caller resizes the
    /// composition before export if needed).
    H264Mp4_4K,
    /// ProRes 422 HQ + 16-bit PCM in MOV. Editing-friendly intermediate.
    ProResMov,
    /// Animated GIF. Two-pass with palettegen/paletteuse for decent quality;
    /// audio dropped.
    Gif,
}

impl ExportPreset {
    pub fn label(self) -> &'static str {
        match self {
            ExportPreset::H264Mp4_1080p => "H.264 MP4 (1080p)",
            ExportPreset::H264Mp4_4K => "H.264 MP4 (4K)",
            ExportPreset::ProResMov => "ProRes 422 HQ (MOV)",
            ExportPreset::Gif => "Animated GIF",
        }
    }

    /// Default file extension for this preset (used by the UI as the save
    /// dialog's `defaultPath` extension).
    pub fn extension(self) -> &'static str {
        match self {
            ExportPreset::H264Mp4_1080p | ExportPreset::H264Mp4_4K => "mp4",
            ExportPreset::ProResMov => "mov",
            ExportPreset::Gif => "gif",
        }
    }

    /// Whether this preset emits an audio track.
    pub fn has_audio(self) -> bool {
        !matches!(self, ExportPreset::Gif)
    }

    /// Append the encoder/codec/container args for this preset to `cmd`.
    /// `hw` lets the caller swap libx264 → h264_nvenc/qsv/etc when the host
    /// has a usable encoder. `None` means software-only.
    pub fn apply_to_command(self, cmd: &mut Command, hw: Option<HwEncoder>) {
        match self {
            ExportPreset::H264Mp4_1080p => {
                apply_h264(cmd, hw, /*crf=*/ 20);
                cmd.args(["-pix_fmt", "yuv420p"]);
                cmd.args(["-c:a", "aac", "-b:a", "192k"]);
            }
            ExportPreset::H264Mp4_4K => {
                apply_h264(cmd, hw, /*crf=*/ 22);
                cmd.args(["-pix_fmt", "yuv420p"]);
                cmd.args(["-c:a", "aac", "-b:a", "256k"]);
            }
            ExportPreset::ProResMov => {
                // ProRes has no hardware encoder we'd rely on; force software.
                cmd.args([
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "3", // HQ
                    "-pix_fmt",
                    "yuv422p10le",
                    "-vendor",
                    "apl0",
                ]);
                cmd.args(["-c:a", "pcm_s16le"]);
            }
            ExportPreset::Gif => {
                // GIF goes through a two-stage filter: palettegen → paletteuse.
                // We *append* to the existing complex filter graph by adding a
                // suffix at command-construction time. See `gif_filter_suffix`.
                cmd.args(["-c:v", "gif", "-loop", "0"]);
            }
        }
    }

    /// Suffix appended to the IR's filtergraph for GIF presets — runs the
    /// final `[vfinal]` through `palettegen` then `paletteuse` to avoid the
    /// 256-color quantization showing up as posterization. Other presets
    /// return `None` and the graph passes through unchanged.
    ///
    /// Caller appends this to the script *before* writing it to disk.
    pub fn filter_graph_suffix(self) -> Option<&'static str> {
        match self {
            ExportPreset::Gif => Some(
                ";\n[vfinal] split [a][b];\n[a] palettegen=stats_mode=diff [pal];\n[b][pal] paletteuse=dither=bayer:bayer_scale=5 [vgif]",
            ),
            _ => None,
        }
    }

    /// The label this preset's emitted graph terminates in. Most presets keep
    /// `[vfinal]` from the IR; GIF replaces it with `[vgif]` after the
    /// palette pass.
    pub fn final_video_label(self) -> &'static str {
        match self {
            ExportPreset::Gif => "[vgif]",
            _ => "[vfinal]",
        }
    }
}

impl Default for ExportPreset {
    fn default() -> Self {
        ExportPreset::H264Mp4_1080p
    }
}

fn apply_h264(cmd: &mut Command, hw: Option<HwEncoder>, crf: u32) {
    match hw {
        Some(HwEncoder::Nvenc) => {
            // NVENC uses CQ instead of CRF; `-cq` gives constant-quality.
            cmd.args(["-c:v", "h264_nvenc", "-preset", "p5", "-cq", &crf.to_string()]);
        }
        Some(HwEncoder::Qsv) => {
            // QSV's `global_quality` is roughly CRF-shaped; lower = better.
            cmd.args([
                "-c:v",
                "h264_qsv",
                "-preset",
                "medium",
                "-global_quality",
                &crf.to_string(),
            ]);
        }
        Some(HwEncoder::Amf) => {
            cmd.args([
                "-c:v",
                "h264_amf",
                "-quality",
                "balanced",
                "-rc",
                "cqp",
                "-qp_i",
                &crf.to_string(),
                "-qp_p",
                &crf.to_string(),
            ]);
        }
        Some(HwEncoder::VideoToolbox) => {
            // VideoToolbox doesn't expose CRF; map crf → -q:v on a similar
            // scale. 20 → ~65 quality (roughly equivalent visual target).
            let q = 100u32.saturating_sub(crf * 2);
            cmd.args(["-c:v", "h264_videotoolbox", "-q:v", &q.to_string()]);
        }
        Some(HwEncoder::Vaapi) => {
            cmd.args([
                "-c:v",
                "h264_vaapi",
                "-qp",
                &crf.to_string(),
            ]);
        }
        None => {
            cmd.args([
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                &crf.to_string(),
            ]);
        }
    }
}
