//! `Project → IRGraph`. Pure function over `&Project` + `RenderTarget`.
//!
//! MVP scope: `Color`, `VideoClip` (video tracks), `AudioParams` (audio
//! tracks), `Overlay` chain, `Amix`. Image/Text/Template/Subtitles/Effects
//! lowering arrives in their feature phases.
//!
//! Animation evaluation: only the static-or-first-keyframe value is read.
//! Per-frame keyframe interpolation is the IR-pass-on-evaluated-Animated work
//! that follows once we have a real preview to diff against.

use thiserror::Error;

use super::graph::IRGraph;
use super::node::{FadeKind, IRNode, NodeId, PixFmt};
use super::target::RenderTarget;
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::ids::MediaId;
use crate::state::layer::{Layer, LayerParams, SubtitlesSource};
use crate::state::project::Project;
use crate::state::track::TrackKind;

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
}

pub fn lower(project: &Project, target: RenderTarget) -> Result<IRGraph, LowerError> {
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
                    current_v = lower_video_layer(&mut g, layer, current_v, project, target)?;
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
                        current_v = lower_video_layer(&mut g, layer, current_v, project, target)?;
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
            let faded = apply_fades(g, fps, layer_dur, p.fade_in_us as i64, p.fade_out_us as i64);

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
            let synth = g.add_node(IRNode::Color {
                rgba: color,
                width: p.width,
                height: p.height,
                fps_num: target.fps.num,
                fps_den: target.fps.den,
                duration_us: layer.t_end_us - layer.t_start_us,
            });
            let placed = g.add_node(IRNode::SetPts {
                in_: synth,
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
            // For inline ASS/SRT, the caller materializes the source to a temp
            // file before lowering and passes the resulting path through a
            // `Media` source. The lower step doesn't write files itself —
            // keeps the function pure.
            let path = match &p.source {
                SubtitlesSource::Media(media_id) => {
                    let media = project
                        .media_pool
                        .get(media_id)
                        .ok_or(LowerError::MissingMedia(*media_id))?;
                    media.path_abs.to_string_lossy().to_string()
                }
                SubtitlesSource::InlineAss(_) | SubtitlesSource::InlineSrt(_) => {
                    return Err(LowerError::InlineSubtitlesNotMaterialized);
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
        LayerParams::Template(_) => Err(LowerError::UnsupportedLayer { kind: "Template" }),
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
        });
    }
    current
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
