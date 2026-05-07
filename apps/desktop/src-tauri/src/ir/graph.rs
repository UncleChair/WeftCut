//! IRGraph — owned node arena. Lowering builds it; passes mutate it; the
//! emitter walks it.

// `IRGraph::kind` classifies nodes for emitter passes; future passes will
// consume it. Suppress lib-only dead-code noise.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::node::{IRNode, InputIdx, NodeId, StreamKind};
use super::target::RenderTarget;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IRGraph {
    pub target: RenderTarget,
    /// Files passed as `-i` to ffmpeg, in declaration order.
    pub inputs: Vec<PathBuf>,
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

    /// Add an input file, deduping by exact path. Returns the input's index.
    pub fn add_input(&mut self, path: &Path) -> InputIdx {
        if let Some(idx) = self.inputs.iter().position(|p| p == path) {
            return idx;
        }
        self.inputs.push(path.to_path_buf());
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
