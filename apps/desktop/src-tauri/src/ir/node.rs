//! Render graph IR nodes. Audio-only post P12-b: the visual half of the IR
//! (lavfi-compositor for export) was deleted with the move to the Pixi
//! renderer. The audio chain survives because `export_audio_only` still
//! routes through `lower → emit_ffmpeg` to fill in `audio.m4a` for the
//! Pixi export's stream-copy mux.

// `StreamKind` and `IRNode::kind` are API for future optimization /
// validation passes that need to discriminate audio vs video edges.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Index into `IRGraph.nodes`. Stable for the lifetime of one graph.
pub type NodeId = usize;

/// Index into `IRGraph.inputs` (the `-i` flag list).
pub type InputIdx = usize;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum IRNode {
    // --- Sources ---
    /// Decode a range of audio.
    DecodeA {
        input: InputIdx,
        src_in_us: i64,
        src_out_us: i64,
    },

    // --- Transforms (1 → 1) ---
    /// Place an audio stream on the timeline.
    Adelay {
        in_: NodeId,
        offset_us: i64,
    },

    // --- Composites (n → 1) ---
    /// Mix multiple audio streams with longest-duration policy.
    Amix {
        inputs: Vec<NodeId>,
    },

    // --- Outputs ---
    OutA {
        in_: NodeId,
        label: String,
        sample_rate: u32,
    },
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
            IRNode::DecodeA { .. }
            | IRNode::Adelay { .. }
            | IRNode::Amix { .. }
            | IRNode::OutA { .. } => StreamKind::Audio,
        }
    }
}
