//! ffmpeg-flavor `lavfi` emitter. Walks `IRGraph` and produces:
//!
//! - The `-i` input list (paths in declaration order).
//! - A `-filter_complex_script`-friendly multi-line filter graph string.
//! - The `-map` arguments for the final audio stream.
//!
//! Audio-only post P12-b — the visual half of the IR was deleted with the
//! Pixi-renderer migration. The audio chain survives because Pixi exports
//! still ask Rust for an audio-only m4a, which gets stream-copy-muxed with
//! the WebCodecs-produced video.mp4.

use super::graph::IRGraph;
use super::node::{IRNode, NodeId};

/// One `-i` argument with optional `-framerate` preamble for image sequences.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanInput {
    pub path: String,
    pub framerate: Option<(u32, u32)>,
}

impl PlanInput {
    /// CLI tokens for this input — `[-framerate, N/D, -i, path]` for image
    /// sequences, just `[-i, path]` otherwise.
    pub fn cli_args(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(4);
        if let Some((n, d)) = self.framerate {
            out.push("-framerate".into());
            out.push(format!("{n}/{d}"));
        }
        out.push("-i".into());
        out.push(self.path.clone());
        out
    }
}

/// Result of emitting a graph for ffmpeg.
#[derive(Clone, Debug, PartialEq)]
pub struct FfmpegPlan {
    /// Inputs in `-i` order. Use [`PlanInput::cli_args`] to build the
    /// per-input argv slice; concatenate them for the full command line.
    pub inputs: Vec<PlanInput>,
    /// Complete `filter_complex_script` body, newline-separated filter steps.
    pub filter_graph: String,
    /// `-map` arguments — `[aout]`.
    pub maps: Vec<String>,
}

pub fn emit(graph: &IRGraph, window_us: Option<(i64, i64)>) -> FfmpegPlan {
    let mut emitter = Emitter::new(graph);
    emitter.emit();
    let mut maps = Vec::new();
    if let Some(out) = graph.audio_out {
        // Compute the final audio label under an immutable borrow of `graph`,
        // then release it before the mutable `emitter.write_clause` below.
        let base_label = match graph.node(out) {
            IRNode::OutA { label, .. } => Some(format!("[{label}]")),
            _ => None,
        };
        if let Some(mut final_label) = base_label {
            if let Some((start_us, end_us)) = window_us {
                let win = "[awin]".to_string();
                emitter.write_clause(&format!(
                    "{final_label} atrim=start={s}:end={e},asetpts=PTS-STARTPTS {win}",
                    s = us_to_secs(start_us),
                    e = us_to_secs(end_us),
                ));
                final_label = win;
            }
            maps.push(final_label);
        }
    }
    FfmpegPlan {
        inputs: graph
            .inputs
            .iter()
            .map(|spec| PlanInput {
                path: spec.path.to_string_lossy().into_owned(),
                framerate: spec.framerate,
            })
            .collect(),
        filter_graph: emitter.body,
        maps,
    }
}

struct Emitter<'a> {
    graph: &'a IRGraph,
    /// Per-node label ("[s3]", "[vA]", etc.) or `None` if not yet emitted.
    labels: Vec<Option<String>>,
    /// Anonymous chain counter, for synthesizing `[s1]`, `[s2]`, ...
    next_chain: usize,
    /// Output buffer.
    body: String,
    /// Has at least one clause been written? Drives the `;` separator.
    started: bool,
}

impl<'a> Emitter<'a> {
    fn new(graph: &'a IRGraph) -> Self {
        Self {
            graph,
            labels: vec![None; graph.nodes.len()],
            next_chain: 0,
            body: String::new(),
            started: false,
        }
    }

    /// Append one filter clause. Inserts `;\n` between clauses (the `;` is
    /// the lavfi separator; the `\n` keeps the script file human-readable).
    /// Without this separator, libavfilter parses the whole script as one
    /// chain and fails with "Trailing garbage after a filter" — silently
    /// breaking every export. Tests that only checked string contents
    /// missed this for a while; the integration test runs ffmpeg.
    fn write_clause(&mut self, clause: &str) {
        if self.started {
            self.body.push_str(";\n");
        }
        self.body.push_str(clause);
        self.started = true;
    }

    fn emit(&mut self) {
        if let Some(out) = self.graph.audio_out {
            self.emit_node(out);
        }
    }

    /// Emits this node and all of its dependencies (depth-first, post-order),
    /// returning its label for use by the caller.
    fn emit_node(&mut self, id: NodeId) -> String {
        if let Some(lbl) = &self.labels[id] {
            return lbl.clone();
        }

        let label = match self.graph.node(id).clone() {
            IRNode::DecodeA {
                input,
                src_in_us,
                src_out_us,
            } => {
                let lbl = self.fresh_label("a");
                let in_lbl = format!("[{input}:a]");
                self.write_clause(&format!(
                    "{in_lbl} atrim={start}:{end},asetpts=PTS-STARTPTS {lbl}",
                    start = us_to_secs(src_in_us),
                    end = us_to_secs(src_out_us),
                ));
                lbl
            }
            IRNode::Adelay { in_, offset_us } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("ad");
                let ms = (offset_us / 1_000).max(0);
                self.write_clause(&format!("{in_lbl} adelay={ms}|{ms} {lbl}"));
                lbl
            }
            IRNode::Amix { inputs } => {
                let in_lbls: Vec<String> = inputs.iter().map(|id| self.emit_node(*id)).collect();
                let lbl = self.fresh_label("amix");
                let chained: String = in_lbls.iter().cloned().collect();
                self.write_clause(&format!(
                    "{chained} amix=inputs={n}:duration=longest:normalize=0 {lbl}",
                    n = inputs.len()
                ));
                lbl
            }
            IRNode::OutA {
                in_,
                label,
                sample_rate,
            } => {
                let in_lbl = self.emit_node(in_);
                let lbl = format!("[{label}]");
                self.write_clause(&format!("{in_lbl} aresample={sample_rate} {lbl}"));
                lbl
            }
        };

        self.labels[id] = Some(label.clone());
        label
    }

    fn fresh_label(&mut self, prefix: &str) -> String {
        self.next_chain += 1;
        format!("[{prefix}{}]", self.next_chain)
    }
}

fn us_to_secs(us: i64) -> String {
    // Six-decimal precision, but trim trailing zeros so common values like "10"
    // stay short.
    let secs = (us as f64) / 1_000_000.0;
    let mut s = format!("{secs:.6}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    s
}
