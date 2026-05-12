//! IRGraph — owned node arena. Lowering builds it; passes mutate it; the
//! emitter walks it.

// `IRGraph::kind` classifies nodes for emitter passes; future passes will
// consume it. Suppress lib-only dead-code noise.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::node::{IRNode, InputIdx, NodeId, StreamKind};
use super::target::RenderTarget;

/// One `-i` argument to ffmpeg. `framerate` is `Some` only for image-sequence
/// inputs (PNG patterns) where ffmpeg won't infer the rate; it emits as
/// `-framerate <num>/<den>` immediately before `-i`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputSpec {
    pub path: PathBuf,
    pub framerate: Option<(u32, u32)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IRGraph {
    pub target: RenderTarget,
    /// Files passed as `-i` to ffmpeg, in declaration order.
    pub inputs: Vec<InputSpec>,
    /// Nodes in topological order — each node references only earlier indices.
    pub nodes: Vec<IRNode>,
    pub video_out: Option<NodeId>,
    pub audio_out: Option<NodeId>,
}

impl IRGraph {
    pub fn new(target: RenderTarget) -> Self {
        Self {
            target,
            inputs: Vec::new(),
            nodes: Vec::new(),
            video_out: None,
            audio_out: None,
        }
    }

    /// Add a regular media file input, deduping by exact path. Returns the
    /// input's index. Use [`add_png_seq`](Self::add_png_seq) for image
    /// sequences — they need a different ffmpeg invocation.
    pub fn add_input(&mut self, path: &Path) -> InputIdx {
        let spec = InputSpec { path: path.to_path_buf(), framerate: None };
        self.add_input_spec(spec)
    }

    /// Add a PNG-sequence input. `pattern_path` is a printf-style path such
    /// as `<dir>/frame_%05d.png`. `framerate` becomes `-framerate N/D`
    /// immediately before `-i`. Deduped on the (path, framerate) pair so two
    /// PngSeq nodes at the same fps reuse one `-i`.
    pub fn add_png_seq(
        &mut self,
        pattern_path: &Path,
        fps_num: u32,
        fps_den: u32,
    ) -> InputIdx {
        let spec = InputSpec {
            path: pattern_path.to_path_buf(),
            framerate: Some((fps_num, fps_den)),
        };
        self.add_input_spec(spec)
    }

    fn add_input_spec(&mut self, spec: InputSpec) -> InputIdx {
        if let Some(idx) = self.inputs.iter().position(|s| s == &spec) {
            return idx;
        }
        self.inputs.push(spec);
        self.inputs.len() - 1
    }

    pub fn add_node(&mut self, node: IRNode) -> NodeId {
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    pub fn node(&self, id: NodeId) -> &IRNode {
        &self.nodes[id]
    }

    pub fn kind(&self, id: NodeId) -> StreamKind {
        self.node(id).kind()
    }
}
