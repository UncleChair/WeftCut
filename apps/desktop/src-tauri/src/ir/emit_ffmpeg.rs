//! ffmpeg-flavor `lavfi` emitter. Walks `IRGraph` and produces:
//!
//! - The `-i` input list (paths in declaration order).
//! - A `-filter_complex_script`-friendly multi-line filter graph string.
//! - The `-map` arguments for the final video and audio streams.
//!
//! libmpv accepts the same filter graph syntax via `--lavfi-complex`, so a
//! libmpv emitter is a thin wrapper that invokes mpv instead of ffmpeg —
//! deferred to Phase 1 polish once libmpv is installed.

use super::graph::IRGraph;
use super::node::{IRNode, NodeId};

/// Escape a subtitles= filter path. ffmpeg's filtergraph parser sees the path
/// inside `'...'`, so single quotes need close-escape-reopen. The colon in
/// drive letters (e.g. `C:/...`) needs `\:` because `:` separates
/// option=value pairs at the filter level (it's literal *inside* `text='...'`,
/// but the subtitles= argument is already past the option-name boundary).
fn subtitles_path_escape(path: &str) -> String {
    path.replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "'\\''")
}

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
                self.write_clause(&format!(
                    "color=c={color}:s={width}x{height}:r={rate}:d={dur} {lbl}"
                ));
                lbl
            }
            IRNode::DecodeV {
                input,
                src_in_us,
                src_out_us,
            } => {
                let lbl = self.fresh_label("v");
                let in_lbl = format!("[{input}:v]");
                self.write_clause(&format!(
                    "{in_lbl} trim={start}:{end},setpts=PTS-STARTPTS {lbl}",
                    start = us_to_secs(src_in_us),
                    end = us_to_secs(src_out_us),
                ));
                lbl
            }
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
            IRNode::ImageDecode { input, duration_us } => {
                let lbl = self.fresh_label("img");
                let in_lbl = format!("[{input}:v]");
                self.write_clause(&format!(
                    "{in_lbl} loop=loop=-1:size=1,trim=duration={dur},setpts=PTS-STARTPTS {lbl}",
                    dur = us_to_secs(duration_us),
                ));
                lbl
            }
            IRNode::Scale { in_, width, height } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("scale");
                self.write_clause(&format!("{in_lbl} scale={width}:{height} {lbl}"));
                lbl
            }
            IRNode::Fps {
                in_,
                fps_num,
                fps_den,
            } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("fps");
                self.write_clause(&format!(
                    "{in_lbl} fps={rate} {lbl}",
                    rate = fps_label(fps_num, fps_den)
                ));
                lbl
            }
            IRNode::SetPts { in_, offset_us } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("pts");
                if offset_us == 0 {
                    self.write_clause(&format!("{in_lbl} setpts=PTS-STARTPTS {lbl}"));
                } else {
                    self.write_clause(&format!(
                        "{in_lbl} setpts=PTS-STARTPTS+{offset}/TB {lbl}",
                        offset = us_to_secs(offset_us)
                    ));
                }
                lbl
            }
            IRNode::Adelay { in_, offset_us } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("ad");
                let ms = (offset_us / 1_000).max(0);
                self.write_clause(&format!("{in_lbl} adelay={ms}|{ms} {lbl}"));
                lbl
            }
            IRNode::Opacity { in_, alpha } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("op");
                self.write_clause(&format!(
                    "{in_lbl} format=yuva420p,colorchannelmixer=aa={alpha} {lbl}"
                ));
                lbl
            }
            IRNode::DrawText {
                in_,
                content,
                font_family,
                font_size,
                color,
                alpha,
                x,
                y,
                gate_start_us,
                gate_end_us,
            } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("dt");
                let escaped = drawtext_quoted_escape(&content);
                let font_opt = drawtext_font_option(&font_family);
                let fontcolor = format!(
                    "0x{:02x}{:02x}{:02x}@{:.6}",
                    color.r,
                    color.g,
                    color.b,
                    (color.a as f64) / 255.0 * alpha
                );
                self.write_clause(&format!(
                    "{in_lbl} drawtext=text='{escaped}':expansion=none:{font_opt}:fontsize={size}:fontcolor={fontcolor}:x={x}:y={y}:enable='between(t,{start},{end})' {lbl}",
                    size = font_size,
                    start = us_to_secs(gate_start_us),
                    end = us_to_secs(gate_end_us),
                ));
                lbl
            }
            IRNode::Fade {
                in_,
                kind,
                start_local_us,
                duration_us,
            } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("fade");
                let dir = kind.as_str();
                let start = us_to_secs(start_local_us);
                let dur = us_to_secs(duration_us);
                self.write_clause(&format!(
                    "{in_lbl} fade=t={dir}:st={start}:d={dur} {lbl}"
                ));
                lbl
            }
            IRNode::Subtitles { in_, path } => {
                let in_lbl = self.emit_node(in_);
                let lbl = self.fresh_label("subs");
                let escaped = subtitles_path_escape(&path);
                self.write_clause(&format!("{in_lbl} subtitles='{escaped}' {lbl}"));
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
                self.write_clause(&format!(
                    "{base_lbl}{top_lbl} overlay=x={x}:y={y}:enable='between(t,{start},{end})':eof_action=pass {lbl}",
                    start = us_to_secs(gate_start_us),
                    end = us_to_secs(gate_end_us),
                ));
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
            IRNode::OutV { in_, label, pix_fmt } => {
                let in_lbl = self.emit_node(in_);
                let lbl = format!("[{label}]");
                self.write_clause(&format!(
                    "{in_lbl} format={pix} {lbl}",
                    pix = pix_fmt.as_str()
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

/// Resolve a font family to the appropriate drawtext option for this OS.
///
/// On Linux/macOS, ffmpeg builds typically ship with a working fontconfig and
/// `font='Arial'` resolves correctly. On Windows, Gyan.FFmpeg builds include
/// libfontconfig but no default `fonts.conf` — emitting `font=...` then fails
/// at runtime with `Fontconfig error: Cannot load default config file`, which
/// kills the filter chain (`MPV_ERROR_LOADING_FAILED` from libmpv's event
/// loop). Bypass fontconfig by emitting `fontfile=` with an absolute TTF path.
/// `C:/Windows/Fonts/arial.ttf` ships on every Windows install.
fn drawtext_font_option(family: &str) -> String {
    if cfg!(target_os = "windows") {
        let path = match family.to_ascii_lowercase().as_str() {
            "times new roman" | "times" => "C:/Windows/Fonts/times.ttf",
            "courier new" | "courier" => "C:/Windows/Fonts/cour.ttf",
            "verdana" => "C:/Windows/Fonts/verdana.ttf",
            "tahoma" => "C:/Windows/Fonts/tahoma.ttf",
            // Arial is the safest fallback — present on every Windows install
            // and what our default `add_demo_text_layer` emits.
            _ => "C:/Windows/Fonts/arial.ttf",
        };
        // The colon in `C:/...` is significant to lavfi's level-2 parser
        // (it separates option=value pairs *inside* the drawtext filter).
        // Single quotes don't help — lavfi consumes them at level 1, then
        // re-parses option strings. Escape the colon explicitly with `\:`.
        let escaped_path = path.replace(':', "\\:");
        format!("fontfile='{escaped_path}'")
    } else {
        let escaped = drawtext_quoted_escape(family);
        format!("font='{escaped}'")
    }
}

/// Escape a string for use inside a single-quoted ffmpeg filtergraph value.
///
/// Inside `'...'` the filtergraph parser treats every char literally except
/// `'` itself, which must be closed-escaped-reopened (`'\''`). `:`, `\`, `%`,
/// and `,` are all literal when quoted, so we don't touch them. Drawtext's
/// own format expansion (`%{pts}`, `%{frame_num}`, etc.) is suppressed at the
/// emit site by `expansion=none`, so the `%` story stays simple.
fn drawtext_quoted_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
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
