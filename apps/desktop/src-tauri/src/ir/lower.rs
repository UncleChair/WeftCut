//! `Project → IRGraph`. Pure function over `&Project` + `RenderTarget`.
//!
//! MVP scope: `Color`, `VideoClip` (video tracks), `AudioParams` (audio
//! tracks), `Overlay` chain, `Amix`. Image/Text/Template/Subtitles/Effects
//! lowering arrives in their feature phases.
//!
//! Animation evaluation: only the static-or-first-keyframe value is read.
//! Per-frame keyframe interpolation is the IR-pass-on-evaluated-Animated work
//! that follows once we have a real preview to diff against.

use std::collections::HashMap;

use thiserror::Error;

use super::graph::IRGraph;
use super::materialize::{InlineSubPaths, TemplateRenders};
use super::node::{FadeKind, IRNode, NodeId, PixFmt};
use super::target::RenderTarget;
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::ids::{LayerId, MediaId};
use crate::state::layer::{Layer, LayerParams, SubtitlesSource};
use crate::state::project::Project;
use crate::state::time::TimeUs;
use crate::state::track::TrackKind;
use crate::state::transition::TransitionKind;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LowerError {
    #[error("layer references missing media {0}")]
    MissingMedia(MediaId),
    #[error("layer kind {kind} is not yet supported by the IR MVP")]
    UnsupportedLayer { kind: &'static str },
    #[error("subtitles file not found: {0}")]
    SubtitlesFileNotFound(String),
    #[error("subtitles inline source must be written to a temp file before lowering")]
    InlineSubtitlesNotMaterialized,
    #[error("template layer {0} not materialized — call ir::materialize_templates first")]
    TemplateNotMaterialized(LayerId),
}

pub fn lower(
    project: &Project,
    target: RenderTarget,
    inline_sub_paths: &InlineSubPaths,
    template_renders: &TemplateRenders,
) -> Result<IRGraph, LowerError> {
    let mut g = IRGraph::new(target);

    // Base canvas spans the whole composition. Minimum 1s so the `color=...`
    // filter has positive duration even when the project is empty.
    let total_dur = project.composition.duration_us.max(1_000_000);
    let bg = project.composition.background;
    let mut current_v: NodeId = g.add_node(IRNode::Color {
        rgba: bg,
        width: target.width,
        height: target.height,
        fps_num: target.fps.num,
        fps_den: target.fps.den,
        duration_us: total_dur,
    });

    let mut audio_streams: Vec<NodeId> = Vec::new();

    // Pre-compute incoming-transition lookup: for each layer that's the
    // `to_layer` of a crossfade, capture its transition duration. The
    // outgoing side needs no special handling — the existing overlay's
    // alpha blending with the incoming layer's alpha-fade produces the
    // crossfade naturally.
    let incoming = incoming_transition_map(project);

    // Tracks: index 0 = bottom of stack, last = top.
    for track in project.tracks.iter() {
        if !track.enabled {
            continue;
        }
        match track.kind {
            TrackKind::Video => {
                for layer in track.layers.iter() {
                    if !layer.enabled {
                        continue;
                    }
                    current_v = lower_video_layer(
                        &mut g,
                        layer,
                        current_v,
                        project,
                        target,
                        inline_sub_paths,
                        template_renders,
                        &incoming,
                    )?;
                }
            }
            TrackKind::Audio => {
                for layer in track.layers.iter() {
                    if !layer.enabled {
                        continue;
                    }
                    if let Some(stream) = lower_audio_layer(&mut g, layer, project)? {
                        audio_streams.push(stream);
                    }
                }
            }
            TrackKind::Subtitle => {
                for layer in track.layers.iter() {
                    if !layer.enabled {
                        continue;
                    }
                    if matches!(layer.params, LayerParams::Subtitles(_)) {
                        current_v = lower_video_layer(
                        &mut g,
                        layer,
                        current_v,
                        project,
                        target,
                        inline_sub_paths,
                        template_renders,
                        &incoming,
                    )?;
                    }
                }
            }
        }
    }

    let v_out = g.add_node(IRNode::OutV {
        in_: current_v,
        label: "vfinal".to_string(),
        pix_fmt: PixFmt::Yuv420p,
    });
    g.video_out = Some(v_out);

    if !audio_streams.is_empty() {
        let mixed = if audio_streams.len() == 1 {
            audio_streams[0]
        } else {
            g.add_node(IRNode::Amix {
                inputs: audio_streams,
            })
        };
        let a_out = g.add_node(IRNode::OutA {
            in_: mixed,
            label: "aout".to_string(),
            sample_rate: target.sample_rate,
        });
        g.audio_out = Some(a_out);
    }

    Ok(g)
}

fn lower_video_layer(
    g: &mut IRGraph,
    layer: &Layer,
    base: NodeId,
    project: &Project,
    target: RenderTarget,
    inline_sub_paths: &InlineSubPaths,
    template_renders: &TemplateRenders,
    incoming: &IncomingTransitions,
) -> Result<NodeId, LowerError> {
    match &layer.params {
        LayerParams::VideoClip(p) => {
            let media = project
                .media_pool
                .get(&p.media)
                .ok_or(LowerError::MissingMedia(p.media))?;
            let input = g.add_input(&media.path_abs);

            let dec = g.add_node(IRNode::DecodeV {
                input,
                src_in_us: p.src_in_us,
                src_out_us: p.src_out_us,
            });

            // Scale: canvas dims, modulated by static transform scale.
            let scale_x = static_or(&p.transform.scale_x, 1.0);
            let scale_y = static_or(&p.transform.scale_y, 1.0);
            let target_w = ((target.width as f64) * scale_x) as u32;
            let target_h = ((target.height as f64) * scale_y) as u32;
            let scaled = g.add_node(IRNode::Scale {
                in_: dec,
                width: target_w.max(1),
                height: target_h.max(1),
            });

            let fps = g.add_node(IRNode::Fps {
                in_: scaled,
                fps_num: target.fps.num,
                fps_den: target.fps.den,
            });

            let layer_dur = (layer.t_end_us - layer.t_start_us).max(0);
            let mut faded = apply_fades(g, fps, layer_dur, p.fade_in_us as i64, p.fade_out_us as i64);

            // Crossfade-in for the incoming side of a transition: alpha-fade
            // the first `duration_us` of this clip's local clock. The
            // outgoing layer's gate still overlays the canvas opaquely, so
            // the linear blend `out = top*alpha + bottom*(1-alpha)` falls
            // out of the existing overlay step.
            if let Some(dur) = incoming.get(&layer.id) {
                faded = apply_crossfade_in(g, faded, (*dur).min(layer_dur));
            }

            let placed = g.add_node(IRNode::SetPts {
                in_: faded,
                offset_us: layer.t_start_us,
            });

            let alpha = static_or(&p.opacity, 1.0);
            let with_alpha = if alpha < 1.0 - 1e-9 {
                g.add_node(IRNode::Opacity {
                    in_: placed,
                    alpha,
                })
            } else {
                placed
            };

            let x = static_or(&p.transform.x, 0.0) as i32;
            let y = static_or(&p.transform.y, 0.0) as i32;

            Ok(g.add_node(IRNode::Overlay {
                base,
                top: with_alpha,
                x,
                y,
                gate_start_us: layer.t_start_us,
                gate_end_us: layer.t_end_us,
            }))
        }
        LayerParams::Color(p) => {
            let color = static_or(&p.color, Rgba::BLACK);
            let layer_dur = layer.t_end_us - layer.t_start_us;
            let synth = g.add_node(IRNode::Color {
                rgba: color,
                width: p.width,
                height: p.height,
                fps_num: target.fps.num,
                fps_den: target.fps.den,
                duration_us: layer_dur,
            });
            // Crossfade-in for the incoming side of a transition (mirrors
            // the VideoClip branch). Color is a synthetic source so we
            // wrap it in `Format(yuva420p)` + `Fade(alpha=1)` before
            // placing it.
            let with_fade = if let Some(dur) = incoming.get(&layer.id) {
                apply_crossfade_in(g, synth, (*dur).min(layer_dur.max(0)))
            } else {
                synth
            };
            let placed = g.add_node(IRNode::SetPts {
                in_: with_fade,
                offset_us: layer.t_start_us,
            });
            Ok(g.add_node(IRNode::Overlay {
                base,
                top: placed,
                x: 0,
                y: 0,
                gate_start_us: layer.t_start_us,
                gate_end_us: layer.t_end_us,
            }))
        }
        LayerParams::ImageOverlay(p) => {
            let media = project
                .media_pool
                .get(&p.media)
                .ok_or(LowerError::MissingMedia(p.media))?;
            let input = g.add_input(&media.path_abs);

            let dur = (layer.t_end_us - layer.t_start_us).max(0);
            let dec = g.add_node(IRNode::ImageDecode {
                input,
                duration_us: dur,
            });

            let fps = g.add_node(IRNode::Fps {
                in_: dec,
                fps_num: target.fps.num,
                fps_den: target.fps.den,
            });

            let faded = apply_fades(g, fps, dur, p.fade_in_us as i64, p.fade_out_us as i64);

            let placed = g.add_node(IRNode::SetPts {
                in_: faded,
                offset_us: layer.t_start_us,
            });

            let alpha = static_or(&p.opacity, 1.0);
            let with_alpha = if alpha < 1.0 - 1e-9 {
                g.add_node(IRNode::Opacity {
                    in_: placed,
                    alpha,
                })
            } else {
                placed
            };

            let x = static_or(&p.transform.x, 0.0) as i32;
            let y = static_or(&p.transform.y, 0.0) as i32;

            // MVP: transform.scale_x/y ignored — image plays at native size.
            // Adding expression-based Scale (`iw*sx:ih*sy`) is a follow-up.

            Ok(g.add_node(IRNode::Overlay {
                base,
                top: with_alpha,
                x,
                y,
                gate_start_us: layer.t_start_us,
                gate_end_us: layer.t_end_us,
            }))
        }
        LayerParams::Subtitles(p) => {
            // Subtitles burn onto whatever video stream is currently the base.
            // For inline ASS/SRT, the caller runs `materialize_inline_subtitles`
            // before `lower` to produce a side map of layer-id → file path.
            // The lower step doesn't write files itself — keeps it pure.
            let path = match &p.source {
                SubtitlesSource::Media(media_id) => {
                    let media = project
                        .media_pool
                        .get(media_id)
                        .ok_or(LowerError::MissingMedia(*media_id))?;
                    media.path_abs.to_string_lossy().to_string()
                }
                SubtitlesSource::InlineAss(_) | SubtitlesSource::InlineSrt(_) => {
                    let path = inline_sub_paths
                        .get(&layer.id)
                        .ok_or(LowerError::InlineSubtitlesNotMaterialized)?;
                    path.to_string_lossy().to_string()
                }
            };
            if !std::path::Path::new(&path).exists() {
                return Err(LowerError::SubtitlesFileNotFound(path));
            }
            Ok(g.add_node(IRNode::Subtitles { in_: base, path }))
        }
        LayerParams::Text(p) => {
            let alpha = static_or(&p.opacity, 1.0);
            let color = static_or(&p.color, Rgba::WHITE);
            let x = static_or(&p.transform.x, 0.0) as i32;
            let y = static_or(&p.transform.y, 0.0) as i32;
            Ok(g.add_node(IRNode::DrawText {
                in_: base,
                content: p.content.clone(),
                font_family: p.font.family.clone(),
                font_size: p.font.size_px,
                color,
                alpha,
                x,
                y,
                gate_start_us: layer.t_start_us,
                gate_end_us: layer.t_end_us,
            }))
        }
        LayerParams::Template(p) => {
            let info = template_renders
                .get(&layer.id)
                .ok_or(LowerError::TemplateNotMaterialized(layer.id))?;

            let input = g.add_png_seq(&info.pattern_path, info.fps_num, info.fps_den);
            let pngseq = g.add_node(IRNode::PngSeq {
                input,
                duration_us: info.duration_us,
                alpha: true,
            });

            // Scale onto the canvas. Templates are authored at their native
            // manifest size; a transform.scale tweak rides on top.
            let scale_x = static_or(&p.transform.scale_x, 1.0);
            let scale_y = static_or(&p.transform.scale_y, 1.0);
            let target_w = ((info.width as f64) * scale_x) as u32;
            let target_h = ((info.height as f64) * scale_y) as u32;
            let scaled = g.add_node(IRNode::Scale {
                in_: pngseq,
                width: target_w.max(1),
                height: target_h.max(1),
            });

            let placed = g.add_node(IRNode::SetPts {
                in_: scaled,
                offset_us: layer.t_start_us,
            });

            let alpha = static_or(&p.opacity, 1.0);
            let with_alpha = if alpha < 1.0 - 1e-9 {
                g.add_node(IRNode::Opacity {
                    in_: placed,
                    alpha,
                })
            } else {
                placed
            };

            let x = static_or(&p.transform.x, 0.0) as i32;
            let y = static_or(&p.transform.y, 0.0) as i32;

            Ok(g.add_node(IRNode::Overlay {
                base,
                top: with_alpha,
                x,
                y,
                gate_start_us: layer.t_start_us,
                gate_end_us: layer.t_end_us,
            }))
        }
        LayerParams::Audio(_) => Err(LowerError::UnsupportedLayer {
            kind: "Audio on video track",
        }),
    }
}

/// Wrap `in_` with fade-in and/or fade-out nodes. Times are in the input
/// stream's local clock (i.e. relative to the trimmed/looped source after
/// `trim`/`setpts=PTS-STARTPTS`). Both fade durations are clamped to
/// `[0, layer_dur]` so a 5s clip with `fade_out_us = 7s` doesn't try to
/// run the fade off the end.
fn apply_fades(
    g: &mut IRGraph,
    in_: NodeId,
    layer_dur_us: i64,
    fade_in_us: i64,
    fade_out_us: i64,
) -> NodeId {
    let mut current = in_;
    let in_dur = fade_in_us.clamp(0, layer_dur_us);
    if in_dur > 0 {
        current = g.add_node(IRNode::Fade {
            in_: current,
            kind: FadeKind::In,
            start_local_us: 0,
            duration_us: in_dur,
            alpha: false,
        });
    }
    let out_dur = fade_out_us.clamp(0, layer_dur_us);
    if out_dur > 0 {
        let start = (layer_dur_us - out_dur).max(0);
        current = g.add_node(IRNode::Fade {
            in_: current,
            kind: FadeKind::Out,
            start_local_us: start,
            duration_us: out_dur,
            alpha: false,
        });
    }
    current
}

type IncomingTransitions = HashMap<LayerId, TimeUs>;

/// Build `to_layer → duration_us` lookup for every crossfade transition in
/// the project. The outgoing side needs no entry — the existing overlay
/// chain on the source clip works as-is, and the incoming clip's alpha-fade
/// gives the visible blend.
fn incoming_transition_map(project: &Project) -> IncomingTransitions {
    let mut map = IncomingTransitions::new();
    for tr in project.transitions.iter() {
        match tr.kind {
            TransitionKind::Crossfade => {
                map.insert(tr.to_layer, tr.duration_us);
            }
        }
    }
    map
}

/// Apply a crossfade-in (`fade=alpha=1` ramping 0 → 1) over the incoming
/// transition's window. Inserts a `Format(yuva420p)` first so the stream
/// has an alpha channel for the fade to operate on. Called only when the
/// layer is the incoming side of a transition.
fn apply_crossfade_in(g: &mut IRGraph, in_: NodeId, duration_us: i64) -> NodeId {
    let with_alpha = g.add_node(IRNode::Format {
        in_,
        pix_fmt: PixFmt::Yuva420p,
    });
    g.add_node(IRNode::Fade {
        in_: with_alpha,
        kind: FadeKind::In,
        start_local_us: 0,
        duration_us,
        alpha: true,
    })
}

fn lower_audio_layer(
    g: &mut IRGraph,
    layer: &Layer,
    project: &Project,
) -> Result<Option<NodeId>, LowerError> {
    if let LayerParams::Audio(p) = &layer.params {
        if p.mute {
            return Ok(None);
        }
        let media = project
            .media_pool
            .get(&p.media)
            .ok_or(LowerError::MissingMedia(p.media))?;
        let input = g.add_input(&media.path_abs);
        let dec = g.add_node(IRNode::DecodeA {
            input,
            src_in_us: p.src_in_us,
            src_out_us: p.src_out_us,
        });
        let placed = g.add_node(IRNode::Adelay {
            in_: dec,
            offset_us: layer.t_start_us,
        });
        Ok(Some(placed))
    } else {
        // Non-audio layers on an audio track silently skip; future phases may
        // surface a structured warning.
        Ok(None)
    }
}

fn static_or<T: Clone>(anim: &Animated<T>, fallback: T) -> T {
    match anim {
        Animated::Static(v) => v.clone(),
        Animated::Keyframed(kfs) => kfs
            .iter()
            .next()
            .map(|kf| kf.value.clone())
            .unwrap_or(fallback),
    }
}
