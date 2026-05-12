//! Render graph IR nodes. One enum keeps the graph homogeneous so passes
//! (lowering, optimization, validation, emit) can match exhaustively.
//!
//! Phase 1.10 MVP scope: just the variants needed for `Color` base, `VideoClip`,
//! and `AudioParams`. Image/Text/Subs/Template/Fade lowering arrives with the
//! relevant feature phases.

// `StreamKind` and `IRNode::kind` are API for future optimization /
// validation passes that need to discriminate audio vs video edges.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::state::color::Rgba;

/// Index into `IRGraph.nodes`. Stable for the lifetime of one graph.
pub type NodeId = usize;

/// Index into `IRGraph.inputs` (the `-i` flag list).
pub type InputIdx = usize;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum IRNode {
    // --- Sources ---
    /// Synthetic solid color. Becomes `color=...` source filter.
    Color {
        rgba: Rgba,
        width: u32,
        height: u32,
        fps_num: u32,
        fps_den: u32,
        duration_us: i64,
    },
    /// Decode a range of video from one of the `-i` inputs.
    DecodeV {
        input: InputIdx,
        src_in_us: i64,
        src_out_us: i64,
    },
    /// Decode a range of audio.
    DecodeA {
        input: InputIdx,
        src_in_us: i64,
        src_out_us: i64,
    },
    /// Single-frame image stretched into a finite-duration video stream.
    /// Emitted as `loop=-1:size=1,trim=duration=<sec>,setpts=PTS-STARTPTS`.
    ImageDecode {
        input: InputIdx,
        duration_us: i64,
    },
    /// PNG-sequence input (a directory of `frame_NNNNN.png` files at a fixed
    /// fps, produced by `raster::render`). `alpha = true` runs the decoded
    /// stream through `format=yuva420p` so the rest of the overlay chain
    /// preserves the per-frame alpha channel — required for any template
    /// that wants to composite over the video below it.
    PngSeq {
        input: InputIdx,
        duration_us: i64,
        alpha: bool,
    },

    // --- Transforms (1 → 1) ---
    Scale {
        in_: NodeId,
        width: u32,
        height: u32,
    },
    Fps {
        in_: NodeId,
        fps_num: u32,
        fps_den: u32,
    },
    /// Place a stream onto the timeline at `offset_us`.
    SetPts {
        in_: NodeId,
        offset_us: i64,
    },
    /// Place an audio stream on the timeline.
    Adelay {
        in_: NodeId,
        offset_us: i64,
    },
    Opacity {
        in_: NodeId,
        alpha: f64,
    },
    /// Burn text onto a video stream. Emits `drawtext=...:enable='between(...)'`.
    /// `font_family` resolves through fontconfig (`font=`) — works on Linux/macOS
    /// and Windows ffmpeg builds with fontconfig (e.g. winget Gyan.FFmpeg).
    /// Outline/shadow/animation presets are deferred to a later slice.
    DrawText {
        in_: NodeId,
        content: String,
        font_family: String,
        font_size: f32,
        color: Rgba,
        alpha: f64,
        x: i32,
        y: i32,
        gate_start_us: i64,
        gate_end_us: i64,
    },
    /// Single-input fade. Both `fade_in` and `fade_out` map to the `fade`
    /// filter (`fade=t=in:st=N:d=D` or `fade=t=out:st=N:d=D`). Times are
    /// expressed in the input stream's local clock so we don't have to know
    /// where the layer sits on the timeline at this stage of the pipeline.
    ///
    /// `alpha = true` adds `:alpha=1` to the filter, ramping only the alpha
    /// channel rather than fading RGB to/from black. Used by crossfade
    /// transition lowering: the incoming clip's first `duration_us` get
    /// alpha 0→1, and the existing `overlay` step does the linear blend.
    /// The input MUST already be in a pixel format that carries alpha
    /// (e.g. `yuva420p` via a [`IRNode::Format`] node).
    Fade {
        in_: NodeId,
        kind: FadeKind,
        start_local_us: i64,
        duration_us: i64,
        alpha: bool,
    },
    /// Pixel-format conversion (`format=<pix_fmt>`). Used before alpha-fades
    /// to ensure the stream has an alpha channel to fade.
    Format {
        in_: NodeId,
        pix_fmt: PixFmt,
    },
    /// Burn an SRT or ASS subtitle file onto a video stream via the `subtitles`
    /// filter (handles both formats; ASS preserves styling). The path is
    /// passed through ffmpeg's subtitles= filter argument so it must be a
    /// stable on-disk file. Inline subtitles are written to a temp file by the
    /// caller before lowering.
    Subtitles {
        in_: NodeId,
        path: String,
    },

    // --- Composites (n → 1) ---
    /// `top` overlaid onto `base` from `gate_start_us` to `gate_end_us`.
    Overlay {
        base: NodeId,
        top: NodeId,
        x: i32,
        y: i32,
        gate_start_us: i64,
        gate_end_us: i64,
    },
    /// Mix multiple audio streams with longest-duration policy.
    Amix {
        inputs: Vec<NodeId>,
    },

    // --- Outputs ---
    OutV {
        in_: NodeId,
        label: String,
        pix_fmt: PixFmt,
    },
    OutA {
        in_: NodeId,
        label: String,
        sample_rate: u32,
    },
}

/// Fade direction. Single-input fade (uses ffmpeg's `fade` filter, not `xfade`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FadeKind {
    In,
    Out,
}

impl FadeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FadeKind::In => "in",
            FadeKind::Out => "out",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PixFmt {
    Yuv420p,
    Yuva420p,
    Rgba,
}

impl PixFmt {
    pub fn as_str(self) -> &'static str {
        match self {
            PixFmt::Yuv420p => "yuv420p",
            PixFmt::Yuva420p => "yuva420p",
            PixFmt::Rgba => "rgba",
        }
    }
}

/// Where this node sits in the dataflow — used by the emitter to label streams.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StreamKind {
    Video,
    Audio,
}

impl IRNode {
    /// Whether this node produces a video or audio stream. Cheap classifier
    /// the emitter uses to pick `[N:v]` vs `[N:a]` and `Amix` vs `Overlay`.
    pub fn kind(&self) -> StreamKind {
        match self {
            IRNode::Color { .. }
            | IRNode::DecodeV { .. }
            | IRNode::ImageDecode { .. }
            | IRNode::PngSeq { .. }
            | IRNode::Scale { .. }
            | IRNode::Fps { .. }
            | IRNode::Opacity { .. }
            | IRNode::DrawText { .. }
            | IRNode::Fade { .. }
            | IRNode::Format { .. }
            | IRNode::Subtitles { .. }
            | IRNode::Overlay { .. }
            | IRNode::OutV { .. } => StreamKind::Video,

            IRNode::DecodeA { .. }
            | IRNode::Adelay { .. }
            | IRNode::Amix { .. }
            | IRNode::OutA { .. } => StreamKind::Audio,

            // SetPts is video-side; Adelay handles audio.
            IRNode::SetPts { .. } => StreamKind::Video,
        }
    }
}
