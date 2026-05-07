//! libmpv-flavor `lavfi` emitter. Same graph shape as `emit_ffmpeg`, three
//! differences:
//!
//! 1. **Input labels.** ffmpeg uses `[N:v]` / `[N:a]` to reference its `-i N`
//!    input streams. libmpv uses `[vid1]` / `[aid1]`, 1-indexed *selected
//!    tracks*: the primary `loadfile` contributes `vid1`/`aid1`, each
//!    `external-files` entry adds `vid2`/`aid2` and so on, in order.
//! 2. **Output labels.** ffmpeg picks any label and `-map`s it. libmpv looks
//!    for the magic names `[vo]` and `[ao]` — only those flow to the screen
//!    and speakers.
//! 3. **No flat `-i` list.** The first graph input becomes mpv's primary file
//!    (`loadfile`); the rest go on `--external-files`. The plan returned here
//!    splits accordingly.
//!
//! Caveat for mixed-stream inputs: `InputIdx N → vid(N+1)/aid(N+1)` assumes
//! each file contributes both selected tracks (or that the graph only ever
//! references the kind it has). A video-only file followed by an audio-only
//! file would break this — mpv numbers vid and aid independently of file
//! order. Out of scope for the Phase 1 MVP fixture (uniform A/V mp4s); fix
//! when the lowerer starts emitting graphs that mix kinds across inputs.

use super::graph::IRGraph;
use super::node::{IRNode, NodeId};

/// Result of emitting a graph for libmpv.
#[derive(Clone, Debug, PartialEq)]
pub struct MpvPlan {
    /// File mpv should `loadfile` first (becomes `vid1`/`aid1`). `None` for
    /// pure-Color projects with no decoded inputs — caller must decide whether
    /// to skip preview or load a synthetic placeholder.
    pub primary: Option<String>,
    /// Remaining input paths, joined into `--external-files`.
    pub external_files: Vec<String>,
    /// Body for `--lavfi-complex`, single-line semicolon-separated. mpv accepts
    /// the same multi-line form ffmpeg does, but single-line is safer when set
    /// through the property API.
    pub lavfi_complex: String,
    /// Whether the graph terminates in `[vo]`.
    pub has_video: bool,
    /// Whether the graph terminates in `[ao]`.
    pub has_audio: bool,
}

pub fn emit(graph: &IRGraph) -> MpvPlan {
    let mut emitter = Emitter::new(graph);
    emitter.emit();

    let inputs: Vec<String> = graph
        .inputs
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let mut iter = inputs.into_iter();
    let primary = iter.next();
    let external_files: Vec<String> = iter.collect();

    MpvPlan {
        primary,
        external_files,
        lavfi_complex: emitter.body,
        has_video: graph.video_out.is_some(),
        has_audio: graph.audio_out.is_some(),
    }
}

struct Emitter<'a> {
    graph: &'a IRGraph,
    labels: Vec<Option<String>>,
    next_chain: usize,
    body: String,
    /// Tracks whether we need a leading `;` before the next clause. Single-line
    /// graphs are mpv-friendly when set through the property API.
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

    fn emit(&mut self) {
        if let Some(out) = self.graph.video_out {
            self.emit_node(out);
        }
        if let Some(out) = self.graph.audio_out {
            self.emit_node(out);
        }
    }

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
                // [0:v] → [vid1], [1:v] → [vid2], 1-indexed selected tracks.
                let in_lbl = format!("[vid{}]", input + 1);
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
                let in_lbl = format!("[aid{}]", input + 1);
                self.write_clause(&format!(
                    "{in_lbl} atrim={start}:{end},asetpts=PTS-STARTPTS {lbl}",
                    start = us_to_secs(src_in_us),
                    end = us_to_secs(src_out_us),
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
            IRNode::OutV { in_, pix_fmt, .. } => {
                let in_lbl = self.emit_node(in_);
                // libmpv looks specifically for [vo].
                let lbl = "[vo]".to_string();
                self.write_clause(&format!(
                    "{in_lbl} format={pix} {lbl}",
                    pix = pix_fmt.as_str()
                ));
                lbl
            }
            IRNode::OutA {
                in_, sample_rate, ..
            } => {
                let in_lbl = self.emit_node(in_);
                let lbl = "[ao]".to_string();
                self.write_clause(&format!("{in_lbl} aresample={sample_rate} {lbl}"));
                lbl
            }
        };

        self.labels[id] = Some(label.clone());
        label
    }

    fn write_clause(&mut self, clause: &str) {
        if self.started {
            self.body.push(';');
        }
        self.body.push_str(clause);
        self.started = true;
    }

    fn fresh_label(&mut self, prefix: &str) -> String {
        self.next_chain += 1;
        format!("[{prefix}{}]", self.next_chain)
    }
}

fn us_to_secs(us: i64) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{lower, target::RenderTarget};
    use crate::state::time::Rational;

    fn fixture_target() -> RenderTarget {
        RenderTarget::full(1920, 1080, Rational::FPS_30, 48_000, 2)
    }

    #[test]
    fn empty_project_emits_color_to_vo() {
        use crate::state::project::Project;
        let p = Project::new_blank("empty");
        let g = lower(&p, fixture_target()).expect("lower");
        let plan = emit(&g);
        assert!(plan.primary.is_none());
        assert!(plan.external_files.is_empty());
        assert!(plan.has_video);
        assert!(!plan.has_audio);
        assert!(plan.lavfi_complex.contains("[vo]"));
        assert!(plan.lavfi_complex.contains("color=c="));
    }

    #[test]
    fn one_clip_uses_vid1_and_terminates_in_vo() {
        // Reuse the same fixture shape as emit_ffmpeg's worked-example test,
        // built inline so we don't depend on the sibling module's helpers.
        use chrono::Utc;
        use uuid::Uuid;

        use crate::state::{
            animated::Animated,
            color::Rgba,
            composition::Composition,
            layer::{Layer, LayerParams, VideoClipParams},
            media::{MediaItem, MediaKind, MediaMetadata},
            project::{Project, ProjectMetadata},
            track::{Track, TrackKind},
            transform::Transform,
        };

        let media_id = Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-000000000002").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-000000000003").unwrap();

        let media = MediaItem {
            id: media_id,
            label: None,
            path_abs: "/m/a.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 0,
            t_end_us: 5_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 5_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
            }),
        };

        let track = Track {
            id: track_id,
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![layer],
        };

        let p = Project {
            schema_version: 1,
            project_id: Uuid::parse_str("01900000-0000-7000-8000-000000000000").unwrap(),
            metadata: ProjectMetadata {
                name: "mpv-mvp".into(),
                created_at: Utc::now(),
                modified_at: Utc::now(),
                description: None,
            },
            composition: Composition {
                width: 1920,
                height: 1080,
                fps: Rational::FPS_30,
                duration_us: 5_000_000,
                sample_rate: 48_000,
                channels: 2,
                color_space: Default::default(),
                background: Rgba::BLACK,
            },
            media_pool: imbl::HashMap::unit(media_id, media),
            tracks: imbl::vector![track],
            markers: imbl::Vector::new(),
            settings: Default::default(),
        };

        let g = lower(&p, fixture_target()).expect("lower");
        let plan = emit(&g);

        assert_eq!(plan.primary.as_deref(), Some("/m/a.mp4"));
        assert!(plan.external_files.is_empty());
        assert!(plan.has_video);
        // No audio in this fixture (VideoClip lowering doesn't auto-emit audio).
        assert!(!plan.has_audio);

        // No `[N:v]` ffmpeg-style references; ends in `[vo]`.
        assert!(!plan.lavfi_complex.contains("[0:v]"));
        assert!(plan.lavfi_complex.contains("[vid1]"));
        assert!(plan.lavfi_complex.trim_end().ends_with("[vo]"));
        // Single-line clauses joined by `;`.
        assert!(!plan.lavfi_complex.contains('\n'));
        assert!(plan.lavfi_complex.contains(';'));
    }
}
