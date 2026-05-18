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

use std::collections::HashSet;

use super::graph::IRGraph;
use super::materialize::{HtmlGroupRenders, InlineSubPaths, TemplateRenders};
use super::node::{FadeKind, IRNode, NodeId, PixFmt};
use super::target::RenderTarget;
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::effect::{Effect, EffectParams};
use crate::state::ids::{GroupId, LayerId, MediaId};
use crate::state::layer::{
    AudioParams, ImageOverlayParams, Layer, LayerParams, SubtitlesSource, VideoClipParams,
};
use crate::state::project::Project;
use crate::state::time::TimeUs;
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
    #[error("html-render group {0} not materialized — call ir::materialize_html_groups first")]
    HtmlGroupNotMaterialized(GroupId),
}

pub fn lower(
    project: &Project,
    target: RenderTarget,
    inline_sub_paths: &InlineSubPaths,
    template_renders: &TemplateRenders,
    html_group_renders: &HtmlGroupRenders,
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

    // Phase H.5 — html-render groups (`docs/html-render-groups.md`):
    // members of `Html`-mode groups are NOT lowered individually on the
    // video side; their visual content is inside the pre-materialized
    // composition PNG sequence. Build a `layer_id → group_id` lookup
    // for fast detection and track which group overlays have been
    // emitted so members after the first are silently skipped.
    let html_group_by_layer: HashMap<LayerId, GroupId> = {
        // Layer-id → does-this-layer-require-html. Built once so the
        // per-group decision below is O(members) instead of walking
        // every track per group.
        let mut layer_html: HashMap<LayerId, bool> = HashMap::new();
        for t in project.tracks.iter() {
            for l in t.layers.iter() {
                if l.requires_html() {
                    layer_html.insert(l.id, true);
                }
            }
        }
        // Pass B.2 (`docs/effects-routing-pass-b.md` §2): walk
        // `effective_groups` — real groups plus synthetic singletons
        // for ungrouped html-required layers — so a standalone
        // keyframed-effect layer isn't silently dropped to ffmpeg
        // where `apply_static_effects` would skip its keyframed
        // entries.
        let effective = crate::state::effective_groups(project);
        let mut m = HashMap::new();
        for g in effective.iter() {
            // Effect-chain redesign (2026-05-17): a group renders via
            // html-cap iff any enabled effect on the group OR any
            // member layer has kind `requires_html()` (today:
            // HtmlTransform).
            let needs_html = crate::state::group_requires_html(g, |lid| {
                *layer_html.get(&lid).unwrap_or(&false)
            });
            if !needs_html {
                continue;
            }
            for &lid in g.members.iter() {
                m.insert(lid, g.id);
            }
        }
        m
    };
    let mut emitted_html_groups: HashSet<GroupId> = HashSet::new();

    // A/B-roll v2 (V.5): walk all tracks (no track-kind filter) and
    // dispatch per LayerParams. Track index still controls z-order
    // for visual layers (index 0 = bottom of stack, last = top); the
    // in-track layer order produces the standard "layers paint in
    // time order" cumulative blend. Audio layers contribute to the
    // mixer regardless of which track they live on.
    for track in project.tracks.iter() {
        if !track.enabled {
            continue;
        }
        for layer in track.layers.iter() {
            if !layer.enabled {
                continue;
            }
            match &layer.params {
                LayerParams::Audio(_) => {
                    // Audio always flows through the amix chain — decision 7
                    // explicitly keeps audio members of Html-mode groups in
                    // the regular audio path.
                    if let Some(stream) = lower_audio_layer(&mut g, layer, project)? {
                        audio_streams.push(stream);
                    }
                }
                // All visual-class kinds flow through the overlay
                // chain: VideoClip / ImageOverlay / Color / Text /
                // Template / Subtitles. The cumulative `current_v`
                // is threaded forward in painted-on-top order.
                LayerParams::VideoClip(_)
                | LayerParams::ImageOverlay(_)
                | LayerParams::Color(_)
                | LayerParams::Text(_)
                | LayerParams::Template(_)
                | LayerParams::Subtitles(_) => {
                    // Html-render group member? Emit one PngSeq overlay
                    // for the whole group on the first encountered
                    // member; subsequent members are part of that
                    // composition and skipped here.
                    if let Some(group_id) = html_group_by_layer.get(&layer.id) {
                        if !emitted_html_groups.contains(group_id) {
                            let info = html_group_renders.get(group_id).ok_or(
                                LowerError::HtmlGroupNotMaterialized(*group_id),
                            )?;
                            current_v = lower_html_group_overlay(
                                &mut g,
                                current_v,
                                info,
                                target,
                            );
                            emitted_html_groups.insert(*group_id);
                        }
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

/// Emit the IR chain for one Html-render group:
/// `PngSeq → Scale → SetPts → Overlay(base=current_v)`.
///
/// The composition was already pre-rasterized at `target` framerate over
/// the group's full duration (see `materialize_html_groups`), so we
/// just feed its frame sequence into the overlay chain at the
/// composition's `t_start_us` offset. No per-frame trim — the PngSeq
/// covers exactly the group's span.
fn lower_html_group_overlay(
    g: &mut IRGraph,
    base: NodeId,
    info: &super::materialize::HtmlGroupRenderInfo,
    target: RenderTarget,
) -> NodeId {
    let input = g.add_png_seq(&info.pattern_path, info.fps_num, info.fps_den);
    let pngseq = g.add_node(IRNode::PngSeq {
        input,
        duration_us: info.duration_us,
        alpha: true,
    });

    // Composition is rendered at the project canvas dimensions
    // (decision 10 — in-place flatten), so it should already match the
    // target. Insert a Scale to the target's exact dimensions defensively
    // — covers the case where a workspace canvas size change happens
    // between materialization and lowering and the cache hasn't been
    // invalidated yet.
    let scaled = g.add_node(IRNode::Scale {
        in_: pngseq,
        width: target.width.max(1),
        height: target.height.max(1),
    });

    let placed = g.add_node(IRNode::SetPts {
        in_: scaled,
        offset_us: info.t_start_us,
    });

    g.add_node(IRNode::Overlay {
        base,
        top: placed,
        x: 0,
        y: 0,
        gate_start_us: info.t_start_us,
        gate_end_us: info.t_start_us + info.duration_us,
    })
}

/// Lower a *time window* of `project` to a video-only IR graph in
/// segment-local time. Audio is intentionally dropped — per the segmented
/// preview design (`docs/preview-segmented-cache.md` decision S4), audio is
/// rendered whole-timeline as a separate file. Used by the preview segment
/// renderer to produce one fMP4 per timeline range.
///
/// Implemented by cloning `project`, rebasing every layer that overlaps
/// `[in_us, out_us]` into segment-local coordinates, and calling the
/// existing [`lower`]. This avoids duplicating the lowering logic; the
/// only new code is the rebase + audio-track filter.
///
/// Layer rebasing rules (see `rebase_layer_for_segment`):
/// - `t_start_us` / `t_end_us` shifted into segment-local time
/// - VideoClip / Audio: `src_in_us` / `src_out_us` advanced when the
///   segment captures only a sub-window of the layer's source (speed=1
///   assumed — `speed != 1` is rejected at apply time elsewhere)
/// - fade_in_us dropped unless the segment captures the layer's original
///   start; fade_out_us dropped unless it captures the layer's original
///   end. Fades sit at layer edges which are by construction hard
///   segment boundaries — they always land in the first/last containing
///   segment, never straddle, so this rule is correct in the common case
/// - Template layers that straddle a segment boundary are dropped: PngSeq
///   has no trim semantics today. A1 limitation; revisit when the template
///   path gains source-time trim
/// - Transitions kept iff both layers survive (transitions are atomic by
///   the boundary algorithm, so this is just a sanity check)
pub fn lower_range(
    project: &Project,
    target: RenderTarget,
    inline_sub_paths: &InlineSubPaths,
    template_renders: &TemplateRenders,
    in_us: TimeUs,
    out_us: TimeUs,
) -> Result<IRGraph, LowerError> {
    let rebased = rebase_project_for_segment(project, in_us, out_us);
    // `lower_range` predates html-render-groups (originally for the
    // deleted preview-segmented-cache path). Pass an empty Html-render
    // map; rebase_project_for_segment doesn't expose group-aware
    // semantics today.
    lower(
        &rebased,
        target,
        inline_sub_paths,
        template_renders,
        &Default::default(),
    )
}

/// Clone `project` with layers rebased into segment-local time. Drops audio
/// tracks entirely (preview audio is whole-timeline). The returned project's
/// `composition.duration_us` equals `out_us - in_us`.
///
/// Exposed `pub(crate)` because the preview-side `segment_hash` needs to
/// enumerate referenced media from the same rebased project that `lower`
/// will actually consume — keeping the rebase in one place avoids
/// drift between "what we hashed" and "what we lower".
pub(crate) fn rebase_project_for_segment(project: &Project, in_us: TimeUs, out_us: TimeUs) -> Project {
    let seg_dur = (out_us - in_us).max(0);
    let mut rebased = project.clone();
    rebased.composition.duration_us = seg_dur;

    // V.5: filter at the LAYER level, not the track level. Audio
    // layers don't render via the segmented-preview pipeline (audio
    // is whole-timeline). Under v2 tracks are kind-agnostic, so a
    // single track can hold both V and A — we keep the track and
    // drop only the audio layers.
    let mut new_tracks = imbl::Vector::new();
    let mut surviving_layer_ids: std::collections::HashSet<LayerId> =
        std::collections::HashSet::new();
    for track in project.tracks.iter() {
        let mut new_layers = imbl::Vector::new();
        for layer in track.layers.iter() {
            if matches!(layer.params, LayerParams::Audio(_)) {
                continue;
            }
            if let Some(rebased_layer) = rebase_layer_for_segment(layer, in_us, out_us) {
                surviving_layer_ids.insert(rebased_layer.id);
                new_layers.push_back(rebased_layer);
            }
        }
        let mut new_track = track.clone();
        new_track.layers = new_layers;
        new_tracks.push_back(new_track);
    }
    rebased.tracks = new_tracks;

    // Filter transitions: keep iff both layers survive in the segment.
    rebased.transitions.retain(|tr| {
        surviving_layer_ids.contains(&tr.from_layer)
            && surviving_layer_ids.contains(&tr.to_layer)
    });

    rebased
}

/// Rebase a single layer into segment-local time. Returns `None` if the
/// layer does not overlap `[in_us, out_us]` or if it's a layer kind that
/// can't be partially rendered (Template straddling a segment boundary).
fn rebase_layer_for_segment(layer: &Layer, in_us: TimeUs, out_us: TimeUs) -> Option<Layer> {
    let layer_start = layer.t_start_us;
    let layer_end = layer.t_end_us;
    // No overlap (half-open intervals — touching at an endpoint doesn't count).
    if layer_end <= in_us || layer_start >= out_us {
        return None;
    }

    // Segment-local timeline placement (clipped + shifted).
    let new_t_start = layer_start.max(in_us) - in_us;
    let new_t_end = layer_end.min(out_us) - in_us;
    if new_t_end <= new_t_start {
        return None;
    }

    // Source-time advance when the segment starts mid-layer; tail truncate
    // when the segment ends mid-layer. Microseconds map 1:1 to source time
    // at speed=1 (the only speed currently supported by lowering anyway).
    let src_advance = (in_us - layer_start).max(0);
    let src_truncate = (layer_end - out_us).max(0);
    let captures_layer_start = in_us <= layer_start;
    let captures_layer_end = out_us >= layer_end;

    let new_params = match &layer.params {
        LayerParams::VideoClip(p) => LayerParams::VideoClip(VideoClipParams {
            src_in_us: p.src_in_us + src_advance,
            src_out_us: p.src_out_us - src_truncate,
            fade_in_us: if captures_layer_start { p.fade_in_us } else { 0 },
            fade_out_us: if captures_layer_end { p.fade_out_us } else { 0 },
            ..p.clone()
        }),
        LayerParams::Audio(p) => LayerParams::Audio(AudioParams {
            src_in_us: p.src_in_us + src_advance,
            src_out_us: p.src_out_us - src_truncate,
            fade_in_us: if captures_layer_start { p.fade_in_us } else { 0 },
            fade_out_us: if captures_layer_end { p.fade_out_us } else { 0 },
            ..p.clone()
        }),
        LayerParams::ImageOverlay(p) => LayerParams::ImageOverlay(ImageOverlayParams {
            fade_in_us: if captures_layer_start { p.fade_in_us } else { 0 },
            fade_out_us: if captures_layer_end { p.fade_out_us } else { 0 },
            ..p.clone()
        }),
        LayerParams::Template(_) => {
            // PngSeq has no trim semantics today; only emit if the segment
            // fully contains the template. Straddling templates render as
            // "not present" in the segment — known A1 limitation.
            if !(captures_layer_start && captures_layer_end) {
                return None;
            }
            layer.params.clone()
        }
        // No source-time or fade params — clamp t_start/t_end only.
        LayerParams::Text(_) | LayerParams::Color(_) | LayerParams::Subtitles(_) => {
            layer.params.clone()
        }
    };

    Some(Layer {
        id: layer.id,
        label: layer.label.clone(),
        t_start_us: new_t_start,
        t_end_us: new_t_end,
        enabled: layer.enabled,
        locked: layer.locked,
        metadata: layer.metadata.clone(),
        effects: layer.effects.clone(),
        params: new_params,
    })
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

            let with_effects = apply_static_effects(g, &layer.effects, with_alpha);

            let x = static_or(&p.transform.x, 0.0) as i32;
            let y = static_or(&p.transform.y, 0.0) as i32;

            Ok(g.add_node(IRNode::Overlay {
                base,
                top: with_effects,
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
            let with_effects = apply_static_effects(g, &layer.effects, placed);
            Ok(g.add_node(IRNode::Overlay {
                base,
                top: with_effects,
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

            let with_effects = apply_static_effects(g, &layer.effects, with_alpha);

            let x = static_or(&p.transform.x, 0.0) as i32;
            let y = static_or(&p.transform.y, 0.0) as i32;

            // MVP: transform.scale_x/y ignored — image plays at native size.
            // Adding expression-based Scale (`iw*sx:ih*sy`) is a follow-up.

            Ok(g.add_node(IRNode::Overlay {
                base,
                top: with_effects,
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

            let with_effects = apply_static_effects(g, &layer.effects, with_alpha);

            let x = static_or(&p.transform.x, 0.0) as i32;
            let y = static_or(&p.transform.y, 0.0) as i32;

            Ok(g.add_node(IRNode::Overlay {
                base,
                top: with_effects,
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

/// Walk a layer's effect chain and emit IR filter nodes for each
/// supported static effect. Returns the extended top NodeId. Keyframed
/// effects are NOT handled here — `Layer::requires_html` routes
/// any-keyframed-effect layers to the html-cap composition path before
/// this is reached, so this helper sees only static-radius effects.
///
/// Today's catalog (commit 1): static `Blur` emits `IRNode::Gblur`.
/// Other static effects (ColorCorrect, etc.) slot in here as their
/// ffmpeg lowering lands.
fn apply_static_effects(
    g: &mut IRGraph,
    effects: &imbl::Vector<Effect>,
    in_: NodeId,
) -> NodeId {
    let mut top = in_;
    for e in effects.iter() {
        if !e.enabled {
            continue;
        }
        match &e.params {
            EffectParams::Blur { radius } => {
                let sigma = static_or(radius, 0.0);
                if sigma > 1e-6 {
                    top = g.add_node(IRNode::Gblur { in_: top, sigma });
                }
            }
            // Keyframed Blur (or any keyframed effect) shouldn't reach
            // here — Layer::requires_html routes the whole layer to
            // html-cap when has_keyframed_params returns true.
            // HtmlTransform always requires_html → also unreachable.
            // ColorCorrect / ChromaKey / Speed / Vignette have no
            // ffmpeg lowering yet — silently skipped, matching pre-
            // commit-1 behavior; their static cases land here as the
            // catalog grows.
            _ => {}
        }
    }
    top
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

#[cfg(test)]
mod tests_lower_range {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::state::animated::Animated;
    use crate::state::color::Rgba;
    use crate::state::composition::Composition;
    use crate::state::ids::new_id;
    use crate::state::layer::{
        AudioParams, ColorParams, Layer, LayerParams, VideoClipParams,
    };
    use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
    use crate::state::project::{Project, ProjectMetadata};
    use crate::state::time::Rational;
    use crate::state::track::Track;
    use crate::state::transform::Transform;
    use crate::state::transition::{Transition, TransitionKind};

    fn target() -> RenderTarget {
        RenderTarget::full(1920, 1080, Rational::FPS_30, 48_000, 2)
    }

    fn mk_media(path: &str, duration_us: i64, kind: MediaKind) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: path.into(),
            path_rel: None,
            kind,
            metadata: MediaMetadata {
                duration_us: Some(duration_us),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    fn mk_video_clip(media_id: MediaId, t_start: i64, t_end: i64, src_in: i64, src_out: i64) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us: t_start,
            t_end_us: t_end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: src_in,
                src_out_us: src_out,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        }
    }

    fn mk_color_layer(t_start: i64, t_end: i64) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us: t_start,
            t_end_us: t_end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::WHITE),
                width: 1920,
                height: 1080,
            }),
        }
    }

    fn mk_project(duration_us: i64, video_layers: Vec<Layer>) -> Project {
        let track = Track {
            id: new_id(),
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: video_layers.into_iter().collect(),
        };
        Project {
            schema_version: 2,
            project_id: new_id(),
            metadata: ProjectMetadata {
                name: "rng-test".into(),
                created_at: Utc::now(),
                modified_at: Utc::now(),
                description: None,
            },
            composition: Composition {
                width: 1920,
                height: 1080,
                fps: Rational::FPS_30,
                duration_us,
                sample_rate: 48_000,
                channels: 2,
                color_space: Default::default(),
                background: Rgba::BLACK,
            },
            media_pool: imbl::HashMap::new(),
            tracks: imbl::vector![track],
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            groups: imbl::Vector::new(),
            settings: Default::default(),
        }
    }

    #[test]
    fn empty_range_emits_color_only_segment() {
        // 5s project with no layers — segment [1s, 3s] is a 2s color base only.
        let p = mk_project(5_000_000, vec![]);
        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 1_000_000, 3_000_000)
            .expect("lower_range");
        assert!(g.inputs.is_empty());
        assert!(g.video_out.is_some());
        // No audio in segments.
        assert!(g.audio_out.is_none());
        // The Color base for the segment is 2s.
        let found = g.nodes.iter().any(|n| matches!(n, IRNode::Color { duration_us: 2_000_000, .. }));
        assert!(found, "expected Color node with 2s duration: {:?}", g.nodes);
    }

    #[test]
    fn audio_track_is_dropped_from_segment() {
        // A project with an audio layer — lower_range MUST emit no audio_out.
        let media = mk_media("/m/audio.wav", 5_000_000, MediaKind::Audio);
        let media_id = media.id;
        let audio_layer = Layer {
            id: new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: 4_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Audio(AudioParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 4_000_000,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
            }),
        };
        let audio_track = Track {
            id: new_id(),
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 48,
            layers: imbl::vector![audio_layer],
        };
        let mut p = mk_project(5_000_000, vec![]);
        p.media_pool.insert(media_id, media);
        p.tracks.push_back(audio_track);

        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 0, 5_000_000)
            .expect("lower_range");
        // No audio_out — segments are video-only.
        assert!(g.audio_out.is_none(), "segment should drop audio entirely");
    }

    #[test]
    fn clip_fully_outside_segment_is_dropped() {
        let media = mk_media("/m/a.mp4", 10_000_000, MediaKind::Video);
        let media_id = media.id;
        let clip = mk_video_clip(media_id, 0, 3_000_000, 0, 3_000_000);
        let mut p = mk_project(10_000_000, vec![clip]);
        p.media_pool.insert(media_id, media);

        // Segment [5s, 8s] doesn't overlap clip [0, 3s].
        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 5_000_000, 8_000_000)
            .expect("lower_range");
        assert!(g.inputs.is_empty(), "clip outside segment should not produce inputs");
    }

    #[test]
    fn clip_straddling_start_advances_src_in() {
        // Clip 0–10s on a media that's also 0–10s. Segment [3s, 8s].
        // Rebased: t_start=0, t_end=5_000_000, src_in=3_000_000, src_out=8_000_000.
        // We can't easily peek into the lower'd graph for src_in directly;
        // instead probe via the emitted ffmpeg graph string.
        let media = mk_media("/m/a.mp4", 10_000_000, MediaKind::Video);
        let media_id = media.id;
        let clip = mk_video_clip(media_id, 0, 10_000_000, 0, 10_000_000);
        let mut p = mk_project(10_000_000, vec![clip]);
        p.media_pool.insert(media_id, media);

        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 3_000_000, 8_000_000)
            .expect("lower_range");
        let plan = crate::ir::emit_ffmpeg(&g);
        // trim=3:8 (seconds) — src window advanced.
        assert!(
            plan.filter_graph.contains("trim=3:8"),
            "expected trim=3:8 in segment graph:\n{}",
            plan.filter_graph,
        );
    }

    #[test]
    fn clip_straddling_end_truncates_src_out() {
        // Clip 0–10s, segment [2s, 7s]. src_in=2, src_out=7.
        let media = mk_media("/m/a.mp4", 10_000_000, MediaKind::Video);
        let media_id = media.id;
        let clip = mk_video_clip(media_id, 0, 10_000_000, 0, 10_000_000);
        let mut p = mk_project(10_000_000, vec![clip]);
        p.media_pool.insert(media_id, media);

        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 2_000_000, 7_000_000)
            .expect("lower_range");
        let plan = crate::ir::emit_ffmpeg(&g);
        assert!(
            plan.filter_graph.contains("trim=2:7"),
            "expected trim=2:7:\n{}",
            plan.filter_graph,
        );
    }

    #[test]
    fn fade_in_dropped_when_segment_starts_mid_clip() {
        // Clip 0–10s with 2s fade-in. Segment [3s, 6s] starts after fade-in
        // ended — the segment graph should not contain the fade-in.
        let media = mk_media("/m/a.mp4", 10_000_000, MediaKind::Video);
        let media_id = media.id;
        let mut clip = mk_video_clip(media_id, 0, 10_000_000, 0, 10_000_000);
        if let LayerParams::VideoClip(ref mut p) = clip.params {
            p.fade_in_us = 2_000_000;
        }
        let mut p = mk_project(10_000_000, vec![clip]);
        p.media_pool.insert(media_id, media);

        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 3_000_000, 6_000_000)
            .expect("lower_range");
        let fade_count = g
            .nodes
            .iter()
            .filter(|n| matches!(n, IRNode::Fade { kind: FadeKind::In, .. }))
            .count();
        assert_eq!(fade_count, 0, "fade-in should be dropped mid-clip");
    }

    #[test]
    fn fade_in_preserved_when_segment_captures_clip_start() {
        let media = mk_media("/m/a.mp4", 10_000_000, MediaKind::Video);
        let media_id = media.id;
        let mut clip = mk_video_clip(media_id, 0, 10_000_000, 0, 10_000_000);
        if let LayerParams::VideoClip(ref mut p) = clip.params {
            p.fade_in_us = 2_000_000;
        }
        let mut p = mk_project(10_000_000, vec![clip]);
        p.media_pool.insert(media_id, media);

        // Segment captures the clip's start (in_us=0).
        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 0, 5_000_000)
            .expect("lower_range");
        let fade_count = g
            .nodes
            .iter()
            .filter(|n| matches!(n, IRNode::Fade { kind: FadeKind::In, .. }))
            .count();
        assert_eq!(fade_count, 1, "fade-in should be preserved when segment captures clip start");
    }

    #[test]
    fn fade_out_dropped_when_segment_ends_before_clip() {
        let media = mk_media("/m/a.mp4", 10_000_000, MediaKind::Video);
        let media_id = media.id;
        let mut clip = mk_video_clip(media_id, 0, 10_000_000, 0, 10_000_000);
        if let LayerParams::VideoClip(ref mut p) = clip.params {
            p.fade_out_us = 2_000_000;
        }
        let mut p = mk_project(10_000_000, vec![clip]);
        p.media_pool.insert(media_id, media);

        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 0, 5_000_000)
            .expect("lower_range");
        let fade_out_count = g
            .nodes
            .iter()
            .filter(|n| matches!(n, IRNode::Fade { kind: FadeKind::Out, .. }))
            .count();
        assert_eq!(fade_out_count, 0, "fade-out should be dropped when segment doesn't reach clip end");
    }

    #[test]
    fn transition_within_segment_is_preserved() {
        // Two color layers with a 1s crossfade — same setup as the
        // crossfade smoke test, but lowered through lower_range covering
        // the transition.
        let a = mk_color_layer(0, 3_000_000);
        let b = mk_color_layer(2_000_000, 5_000_000);
        let a_id = a.id;
        let b_id = b.id;
        let mut p = mk_project(5_000_000, vec![a, b]);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: b_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });

        // Segment [1s, 4s] contains the full transition [2,3].
        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 1_000_000, 4_000_000)
            .expect("lower_range");
        let plan = crate::ir::emit_ffmpeg(&g);
        // The alpha-fade crossfade emission survives the rebase.
        assert!(
            plan.filter_graph.contains("alpha=1"),
            "expected alpha=1 in segment graph containing transition:\n{}",
            plan.filter_graph,
        );
    }

    #[test]
    fn segment_local_time_starts_at_zero() {
        // The Color base of the segment must use the segment's duration, not
        // the whole project's. Segment [3s, 8s] → Color duration 5s.
        let p = mk_project(20_000_000, vec![]);
        let g = lower_range(&p, target(), &Default::default(), &Default::default(), 3_000_000, 8_000_000)
            .expect("lower_range");
        let found = g.nodes.iter().any(|n| matches!(n, IRNode::Color { duration_us: 5_000_000, .. }));
        assert!(found, "expected segment-local Color duration of 5s: {:?}", g.nodes);
    }

    #[test]
    fn standalone_keyframed_layer_routes_to_html_group() {
        // Pass B.2: a standalone (no-group) layer with a keyframed
        // effect now routes via a synthetic singleton group. The
        // lower pass should detect this and request html-group
        // materialization for that layer's synthetic group id —
        // when html_group_renders is empty, lower returns
        // HtmlGroupNotMaterialized rather than silently dropping
        // the keyframed effect (which was the pre-B.2 behavior at
        // apply_static_effects skip-with-noop).
        use crate::state::animated::{Animated, Interpolation, Keyframe};
        use crate::state::effect::{Effect, EffectParams};
        use crate::state::group::synthetic_group_id_for_layer;

        let media = mk_media("/m/clip.mp4", 30_000_000, MediaKind::Video);
        let media_id = media.id;
        let mut clip = mk_video_clip(media_id, 0, 30_000_000, 0, 30_000_000);
        // Attach a keyframed Blur to the standalone layer.
        let kf_id = new_id();
        clip.effects = imbl::vector![Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::Blur {
                radius: Animated::Keyframed(imbl::vector![
                    Keyframe { id: kf_id, t_us: 14_000_000, value: 0.0, interp: Interpolation::Linear },
                    Keyframe { id: new_id(), t_us: 15_000_000, value: 8.0, interp: Interpolation::Linear },
                    Keyframe { id: new_id(), t_us: 16_000_000, value: 0.0, interp: Interpolation::Linear },
                ]),
            },
        }];
        let clip_id = clip.id;
        let mut p = mk_project(30_000_000, vec![clip]);
        p.media_pool.insert(media_id, media);

        // No html_group_renders supplied; lower should error with the
        // synthetic group id (proving the routing identified the layer).
        let result = lower(
            &p,
            target(),
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        let expected_gid = synthetic_group_id_for_layer(clip_id);
        match result {
            Err(LowerError::HtmlGroupNotMaterialized(gid)) => {
                assert_eq!(gid, expected_gid, "expected synthetic group id for standalone keyframed layer");
            }
            other => panic!("expected HtmlGroupNotMaterialized for standalone keyframed layer, got {:?}", other),
        }
    }
}
