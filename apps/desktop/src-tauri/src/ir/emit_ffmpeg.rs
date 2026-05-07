//! ffmpeg-flavor `lavfi` emitter. Walks `IRGraph` and produces:
//!
//! - The `-i` input list (paths in declaration order).
//! - A `-filter_complex_script`-friendly multi-line filter graph string.
//! - The `-map` arguments for the final video and audio streams.
//!
//! libmpv accepts the same filter graph syntax via `--lavfi-complex`, so a
//! libmpv emitter is a thin wrapper that invokes mpv instead of ffmpeg —
//! deferred to Phase 1 polish once libmpv is installed.

use std::fmt::Write;

use super::graph::IRGraph;
use super::node::{IRNode, NodeId};

/// Result of emitting a graph for ffmpeg.
#[derive(Clone, Debug, PartialEq)]
pub struct FfmpegPlan {
    /// Input file paths, in `-i` order.
    pub inputs: Vec<String>,
    /// Complete `filter_complex_script` body, newline-separated filter steps.
    pub filter_graph: String,
    /// `-map` arguments — `[vfinal]`, `[aout]`, etc.
    pub maps: Vec<String>,
}

pub fn emit(graph: &IRGraph) -> FfmpegPlan {
    let mut emitter = Emitter::new(graph);
    emitter.emit();
    let mut maps = Vec::new();
    if let Some(out) = graph.video_out {
        if let IRNode::OutV { label, .. } = graph.node(out) {
            maps.push(format!("[{label}]"));
        }
    }
    if let Some(out) = graph.audio_out {
        if let IRNode::OutA { label, .. } = graph.node(out) {
            maps.push(format!("[{label}]"));
        }
    }
    FfmpegPlan {
        inputs: graph
            .inputs
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
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
}

impl<'a> Emitter<'a> {
    fn new(graph: &'a IRGraph) -> Self {
        Self {
            graph,
            labels: vec![None; graph.nodes.len()],
            next_chain: 0,
            body: String::new(),
        }
    }

    fn emit(&mut self) {
        // Drive emission from the outputs so we only walk the reachable graph.
        if let Some(out) = self.graph.video_out {
            self.emit_node(out);
        }
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
            IRNode::Color {
                rgba,
                width,
                height,
                fps_num,
                fps_den,
                duration_us,
            } => {
                let lbl = self.fresh_label("c");
                let dur = us_to_secs(duration_us);
                let rate = fps_label(fps_num, fps_den);
                let color = rgba_hex(rgba);
                writeln!(
                    self.body,
                    "color=c={color}:s={width}x{height}:r={rate}:d={dur} {lbl}"
                )
                .unwrap();
                lbl
            }
            IRNode::DecodeV {
                input,
                src_in_us,
                src_out_us,
            } => {
                let lbl = self.fresh_label("v");
                let in_lbl = format!("[{input}:v]");
                writeln!(
                    self.body,
                    "{in_lbl} trim={start}:{end},setpts=PTS-STARTPTS {lbl}",
                    start = us_to_secs(src_in_us),
                    end = us_to_secs(src_out_us),
                )
                .unwrap();
                lbl
            }
            IRNode::DecodeA {
                input,
                src_in_us,
                src_out_us,
            } => {
                let lbl = self.fresh_label("a");
                let in_lbl = format!("[{input}:a]");
                writeln!(
                    self.body,
                    "{in_lbl} atrim={start}:{end},asetpts=PTS-STARTPTS {lbl}",
                    start = us_to_secs(src_in_us),
                    end = us_to_secs(src_out_us),
                )
                .unwrap();
                lbl
            }
            IRNode::Scale { in_, width, height } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("scale");
                writeln!(self.body, "{in_lbl} scale={width}:{height} {lbl}").unwrap();
                lbl
            }
            IRNode::Fps {
                in_,
                fps_num,
                fps_den,
            } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("fps");
                writeln!(
                    self.body,
                    "{in_lbl} fps={rate} {lbl}",
                    rate = fps_label(fps_num, fps_den)
                )
                .unwrap();
                lbl
            }
            IRNode::SetPts { in_, offset_us } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("pts");
                if offset_us == 0 {
                    writeln!(self.body, "{in_lbl} setpts=PTS-STARTPTS {lbl}").unwrap();
                } else {
                    writeln!(
                        self.body,
                        "{in_lbl} setpts=PTS-STARTPTS+{offset}/TB {lbl}",
                        offset = us_to_secs(offset_us)
                    )
                    .unwrap();
                }
                lbl
            }
            IRNode::Adelay { in_, offset_us } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("ad");
                let ms = (offset_us / 1_000).max(0);
                writeln!(self.body, "{in_lbl} adelay={ms}|{ms} {lbl}").unwrap();
                lbl
            }
            IRNode::Opacity { in_, alpha } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("op");
                writeln!(
                    self.body,
                    "{in_lbl} format=yuva420p,colorchannelmixer=aa={alpha} {lbl}"
                )
                .unwrap();
                lbl
            }
            IRNode::Overlay {
                base,
                top,
                x,
                y,
                gate_start_us,
                gate_end_us,
            } => {
                let base_lbl = self.emit_node(base);
                let top_lbl = self.emit_node(top);
                let lbl = self.fresh_label("s");
                writeln!(
                    self.body,
                    "{base_lbl}{top_lbl} overlay=x={x}:y={y}:enable='between(t,{start},{end})':eof_action=pass {lbl}",
                    start = us_to_secs(gate_start_us),
                    end = us_to_secs(gate_end_us),
                )
                .unwrap();
                lbl
            }
            IRNode::Amix { inputs } => {
                let in_lbls: Vec<String> = inputs.iter().map(|id| self.emit_node(*id)).collect();
                let lbl = self.fresh_label("amix");
                let chained: String = in_lbls.iter().cloned().collect();
                writeln!(
                    self.body,
                    "{chained} amix=inputs={n}:duration=longest:normalize=0 {lbl}",
                    n = inputs.len()
                )
                .unwrap();
                lbl
            }
            IRNode::OutV { in_, label, pix_fmt } => {
                let in_lbl = self.emit_node(in_);
                let lbl = format!("[{label}]");
                writeln!(
                    self.body,
                    "{in_lbl} format={pix} {lbl}",
                    pix = pix_fmt.as_str()
                )
                .unwrap();
                lbl
            }
            IRNode::OutA {
                in_,
                label,
                sample_rate,
            } => {
                let in_lbl = self.emit_node(in_);
                let lbl = format!("[{label}]");
                writeln!(self.body, "{in_lbl} aresample={sample_rate} {lbl}").unwrap();
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
    // stay short. `to_string` would default-format but we need explicit %.6f.
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

fn fps_label(num: u32, den: u32) -> String {
    if den == 1 {
        num.to_string()
    } else {
        format!("{num}/{den}")
    }
}

fn rgba_hex(c: crate::state::color::Rgba) -> String {
    format!(
        "0x{:02x}{:02x}{:02x}@{:.6}",
        c.r,
        c.g,
        c.b,
        (c.a as f64) / 255.0
    )
}
