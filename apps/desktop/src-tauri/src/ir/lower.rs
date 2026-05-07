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
use super::node::{IRNode, NodeId, PixFmt};
use super::target::RenderTarget;
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::ids::MediaId;
use crate::state::layer::{Layer, LayerParams};
use crate::state::project::Project;
use crate::state::track::TrackKind;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LowerError {
    #[error("layer references missing media {0}")]
    MissingMedia(MediaId),
    #[error("layer kind {kind} is not yet supported by the IR MVP")]
    UnsupportedLayer { kind: &'static str },
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
                // MVP: subtitles deferred to Phase 2 (DrawText/Subs nodes).
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

            let placed = g.add_node(IRNode::SetPts {
                in_: fps,
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
        LayerParams::ImageOverlay(_) => Err(LowerError::UnsupportedLayer { kind: "ImageOverlay" }),
        LayerParams::Text(_) => Err(LowerError::UnsupportedLayer { kind: "Text" }),
        LayerParams::Template(_) => Err(LowerError::UnsupportedLayer { kind: "Template" }),
        LayerParams::Subtitles(_) => Err(LowerError::UnsupportedLayer { kind: "Subtitles" }),
        LayerParams::Audio(_) => Err(LowerError::UnsupportedLayer {
            kind: "Audio on video track",
        }),
    }
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
