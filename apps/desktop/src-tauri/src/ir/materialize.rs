//! Pre-lower materialization pass for inline subtitle bodies.
//!
//! `SubtitlesSource::InlineSrt(String)` / `InlineAss(String)` carry the
//! subtitle body inline so projects round-trip cleanly through `.vproj`
//! and so MCP tools (auto-caption, agent-authored cues) don't need to
//! invent file paths. ffmpeg's `subtitles=` filter only accepts a path —
//! so we materialize each inline body to a content-addressed file in
//! the OS app cache before lowering.
//!
//! Pure in the sense that it's deterministic (same body → same hash →
//! same file) and idempotent (skip-if-cached); it does write files.
//! Project state is unchanged — this returns a side map keyed by
//! `LayerId` that `lower()` consults for inline-source Subtitles
//! layers. Persisting the project still emits `InlineSrt(String)`.

use std::path::PathBuf;

use thiserror::Error;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::state::ids::LayerId;
use crate::state::layer::{LayerParams, SubtitlesSource};
use crate::state::project::Project;

pub type InlineSubPaths = imbl::HashMap<LayerId, PathBuf>;

/// Per-Template-layer rasterization result the lower pass needs to emit a
/// `PngSeq → Scale → SetPts → Overlay` chain. `pattern_path` is the printf
/// glob `<dir>/frame_%05d.png` that `IRGraph::add_png_seq` consumes; the
/// other fields drive the framerate flag, the layer's effective duration,
/// and the destination canvas size.
#[derive(Clone, Debug)]
pub struct TemplateRenderInfo {
    pub pattern_path: PathBuf,
    pub frame_count: usize,
    pub fps_num: u32,
    pub fps_den: u32,
    pub duration_us: i64,
    pub width: u32,
    pub height: u32,
}

pub type TemplateRenders = imbl::HashMap<LayerId, TemplateRenderInfo>;

/// Per-Html-group materialization result. Parallels `TemplateRenderInfo`
/// (the lower pass emits the same `PngSeq → SetPts → Overlay` chain) but
/// also tracks the group's earliest-member t_start so the SetPts offset
/// places the composition correctly on the parent timeline.
#[derive(Clone, Debug)]
pub struct HtmlGroupRenderInfo {
    pub pattern_path: PathBuf,
    pub frame_count: usize,
    pub fps_num: u32,
    pub fps_den: u32,
    pub duration_us: i64,
    pub width: u32,
    pub height: u32,
    /// Earliest visual member's `t_start_us` in main-timeline. The IR
    /// `SetPts` node uses this as its offset; engine-side time is
    /// composition-local (member.t_start − this value).
    pub t_start_us: i64,
}

pub type HtmlGroupRenders = imbl::HashMap<crate::state::ids::GroupId, HtmlGroupRenderInfo>;

#[derive(Debug, Error)]
pub enum MaterializeError {
    #[error("write inline subtitle for layer {layer}: {source}")]
    Write {
        layer: LayerId,
        #[source]
        source: std::io::Error,
    },
    #[error("unknown template `{template_id}` referenced by layer {layer}")]
    UnknownTemplate {
        layer: LayerId,
        template_id: String,
    },
    #[error("invalid props for template on layer {layer}: {detail}")]
    PropsValidation { layer: LayerId, detail: String },
    #[error("rasterizer failed for layer {layer}: {detail}")]
    Render { layer: LayerId, detail: String },
}

/// Walk every Subtitles layer with an inline body, hash it, and write a
/// content-addressed file under `<cache>/inline-subs/<hash>.<ext>`.
/// Returns the layer-id → path map; lookup-and-fall-back to
/// `SubtitlesSource::Media` happens in `lower()`.
pub fn materialize_inline_subtitles(
    project: &Project,
    cache: &CacheLayout,
) -> Result<InlineSubPaths, MaterializeError> {
    let mut out = InlineSubPaths::new();
    for track in project.tracks.iter() {
        for layer in track.layers.iter() {
            let LayerParams::Subtitles(p) = &layer.params else {
                continue;
            };
            let (body, ext) = match &p.source {
                SubtitlesSource::InlineSrt(s) => (s.as_str(), "srt"),
                SubtitlesSource::InlineAss(s) => (s.as_str(), "ass"),
                SubtitlesSource::Media(_) => continue,
            };
            let hash = blake3::hash(body.as_bytes()).to_hex().to_string();
            let dest = cache.inline_subs(&hash, ext);
            if !cached_ok(&dest) {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|source| {
                        MaterializeError::Write {
                            layer: layer.id,
                            source,
                        }
                    })?;
                }
                let tmp = temp_path(&dest);
                if let Err(source) = std::fs::write(&tmp, body.as_bytes()) {
                    discard_temp(&dest);
                    return Err(MaterializeError::Write {
                        layer: layer.id,
                        source,
                    });
                }
                if let Err(source) = promote_temp(&dest).map_err(io_from_anyhow) {
                    discard_temp(&dest);
                    return Err(MaterializeError::Write {
                        layer: layer.id,
                        source,
                    });
                }
            }
            out.insert(layer.id, dest);
        }
    }
    Ok(out)
}

fn io_from_anyhow(e: anyhow::Error) -> std::io::Error {
    std::io::Error::other(format!("{e:#}"))
}

/// Walk every `Template` layer, call `raster::render` against the built-in
/// template registry, and return per-layer pointers into the content-keyed
/// raster cache. Idempotent — every cache hit skips the webview entirely.
///
/// fps and duration are derived from the layer's timeline span: we sample
/// at `composition.fps` so the resulting PngSeq frame rate matches the
/// project's, avoiding extra resampling at emit time. A 1-second layer at
/// 30 fps materializes 30 frames; a 200 ms layer at 30 fps materializes 6.
pub async fn materialize_templates(
    project: &Project,
    cache: &CacheLayout,
    app: &tauri::AppHandle,
) -> Result<TemplateRenders, MaterializeError> {
    use crate::raster::{self, template};

    let builtins = template::builtins();
    let mut out = TemplateRenders::new();
    let fps_num = project.composition.fps.num.max(1);
    let fps_den = project.composition.fps.den.max(1);
    let fps_f = fps_num as f64 / fps_den as f64;

    for track in project.tracks.iter() {
        for layer in track.layers.iter() {
            let LayerParams::Template(p) = &layer.params else {
                continue;
            };
            let template = builtins
                .iter()
                .find(|t| t.id() == p.template_id)
                .cloned()
                .ok_or_else(|| MaterializeError::UnknownTemplate {
                    layer: layer.id,
                    template_id: p.template_id.clone(),
                })?;

            // imbl::HashMap<String, Value> → serde_json::Value::Object.
            let mut props_obj = serde_json::Map::new();
            for (k, v) in p.props.iter() {
                props_obj.insert(k.clone(), v.clone());
            }
            let canonical = template
                .canonicalize_props(&serde_json::Value::Object(props_obj))
                .map_err(|e| MaterializeError::PropsValidation {
                    layer: layer.id,
                    detail: e.to_string(),
                })?;

            let duration_us = (layer.t_end_us - layer.t_start_us).max(1);
            let dur_s = duration_us as f64 / 1_000_000.0;
            let frame_count = ((dur_s * fps_f).ceil() as usize).max(1);
            let times_s: Vec<f64> = (0..frame_count)
                .map(|i| i as f64 / fps_f)
                .collect();

            let (w, h) = template.size();
            let job = raster::RasterJob {
                template,
                props_canonical_json: canonical,
                fps: fps_num,
                times_s,
            };
            let render = raster::render(app, cache, job).await.map_err(|detail| {
                MaterializeError::Render {
                    layer: layer.id,
                    detail,
                }
            })?;

            out.insert(
                layer.id,
                TemplateRenderInfo {
                    pattern_path: render.dir.join("frame_%05d.png"),
                    frame_count: render.frames.len(),
                    fps_num,
                    fps_den,
                    duration_us,
                    width: w,
                    height: h,
                },
            );
        }
    }
    Ok(out)
}

// ============================================================
// Phase H.5 — html-render groups materialization
// ============================================================

/// Walk every `Html`-mode group, distill its `CompositionState`, and
/// drive the offscreen raster worker to produce a PNG sequence per
/// group. Returns the resulting `HtmlGroupRenders` map; `lower()`
/// consults it to emit `PngSeq` nodes in place of the group's
/// individual member overlays.
///
/// H.5 v1 limitation: VideoClip + ImageOverlay members render as
/// placeholders inside the composition (real per-frame extraction
/// arrives in the H.5 follow-up). Template + Subtitles members are
/// skipped with a warn — the composition generator + engine don't
/// support those kinds yet (H.3 follow-up).
pub async fn materialize_html_groups(
    project: &Project,
    cache: &CacheLayout,
    app: &tauri::AppHandle,
) -> Result<HtmlGroupRenders, MaterializeError> {
    use crate::raster::composition::{
        CompositionLayer, CompositionLayerParams, CompositionState, Rgba8,
    };
    use crate::raster::html_group;
    use crate::state::layer::LayerParams;

    let mut out = HtmlGroupRenders::new();
    let fps_num = project.composition.fps.num.max(1);
    let fps_den = project.composition.fps.den.max(1);
    let canvas_w = project.composition.width;
    let canvas_h = project.composition.height;

    // Build a layer-id → (Layer, track_index) lookup once.
    let mut layer_lookup: std::collections::HashMap<
        LayerId,
        (&crate::state::layer::Layer, usize),
    > = std::collections::HashMap::new();
    for (idx, track) in project.tracks.iter().enumerate() {
        for layer in track.layers.iter() {
            layer_lookup.insert(layer.id, (layer, idx));
        }
    }

    // Pass B.2 (`docs/effects-routing-pass-b.md` §2): use
    // `effective_groups` so ungrouped html-required layers get
    // materialized via a deterministic synthetic singleton group.
    let effective = crate::state::effective_groups(project);
    for group in effective.iter() {
        // Effect-chain redesign: a group materializes for html-cap iff
        // any enabled effect on the group OR any enabled effect on
        // any member layer `requires_html()`. Today the only such
        // kind is `HtmlTransform`.
        let needs_html = crate::state::group_requires_html(group, |lid| {
            layer_lookup
                .get(&lid)
                .map(|(l, _)| l.requires_html())
                .unwrap_or(false)
        });
        if !needs_html {
            continue;
        }

        // Collect supported visual members.
        let mut members: Vec<(&crate::state::layer::Layer, usize)> = Vec::new();
        for &lid in group.members.iter() {
            let Some(&(layer, track_idx)) = layer_lookup.get(&lid) else {
                continue;
            };
            if !layer.enabled {
                continue;
            }
            match &layer.params {
                LayerParams::Audio(_) => continue, // routed via amix
                LayerParams::Subtitles(_) => {
                    // Subtitles in html-cap compositions need libass-wasm
                    // (JASSUB) inside the offscreen webview. Tracked as a
                    // follow-up; for now keep the standalone Subtitles
                    // render path (ffmpeg `subtitles=` filter) running
                    // outside any html-cap group.
                    tracing::warn!(
                        "html-render group {}: skipping layer {} (kind=Subtitles) — JASSUB integration pending",
                        group.id,
                        lid,
                    );
                    continue;
                }
                LayerParams::Color(_)
                | LayerParams::Text(_)
                | LayerParams::VideoClip(_)
                | LayerParams::ImageOverlay(_)
                | LayerParams::Template(_) => {
                    // Templates now render inside compositions via the
                    // engine's per-host shadow-DOM + scripted-globals path
                    // (the materializer below embeds the parsed template
                    // pieces into the composition state).
                    members.push((layer, track_idx));
                }
            }
        }
        if members.is_empty() {
            continue;
        }
        members.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.t_start_us.cmp(&b.0.t_start_us)));

        let group_t_start_us = members
            .iter()
            .map(|(l, _)| l.t_start_us)
            .min()
            .unwrap_or(0);
        let group_t_end_us = members
            .iter()
            .map(|(l, _)| l.t_end_us)
            .max()
            .unwrap_or(group_t_start_us);
        let duration_us = (group_t_end_us - group_t_start_us).max(1);

        // Distill composition state. Builds the per-layer
        // `CompositionLayerParams` AND the parallel list of media
        // sources to pre-extract — VideoClip frame patterns +
        // ImageOverlay normalized images live next to the
        // composition.html in the per-group cache dir.
        let mut sources: Vec<html_group::VideoSource> = Vec::new();
        let layers: Vec<CompositionLayer> = members
            .iter()
            .enumerate()
            .map(|(idx, (l, _))| {
                let params = composition_params_for_export(
                    l, project, canvas_w, canvas_h, fps_num, fps_den, &mut sources,
                );
                let (opacity, x, y, scale_x, scale_y) = position_for(&l.params);
                let effect_transform = pick_html_transform(l.effects.iter());
                let effect_filter = pick_blur(l.effects.iter());
                CompositionLayer {
                    id: l.id.to_string(),
                    z: idx as u32,
                    t_start_us: l.t_start_us - group_t_start_us,
                    t_end_us: l.t_end_us - group_t_start_us,
                    opacity,
                    x,
                    y,
                    scale_x,
                    scale_y,
                    params,
                    effect_transform,
                    effect_filter,
                }
            })
            .collect();

        let composition_transform = pick_composition_transform(group);
        let composition_filter = pick_blur(group.effects.iter());
        let state = CompositionState {
            width: canvas_w,
            height: canvas_h,
            fps_num,
            fps_den,
            layers,
            composition_transform,
            composition_filter,
        };

        let group_id_str = group.id.to_string();
        let render = html_group::materialize_group(
            app,
            cache,
            &group_id_str,
            &state,
            &sources,
            fps_num,
            fps_den,
            duration_us,
        )
        .await
        .map_err(|detail| MaterializeError::Render {
            // No layer id here — the error is per-group. Surface the
            // group id as the "layer" slot for consistency with the
            // existing error shape until a richer variant lands.
            layer: members[0].0.id,
            detail: format!("html-group {}: {detail}", group_id_str),
        })?;

        out.insert(
            group.id,
            HtmlGroupRenderInfo {
                pattern_path: render.pattern_path,
                frame_count: render.frame_count,
                fps_num: render.fps_num,
                fps_den: render.fps_den,
                duration_us: render.duration_us,
                width: render.width,
                height: render.height,
                t_start_us: group_t_start_us,
            },
        );

        // Suppress unused-Rgba8 warning when the only constructed
        // variant is via composition_params below.
        let _ = std::marker::PhantomData::<Rgba8>;
    }
    Ok(out)
}

fn position_for(params: &crate::state::layer::LayerParams) -> (f64, f64, f64, f64, f64) {
    use crate::state::animated::Animated;
    use crate::state::layer::LayerParams;
    fn static_or<T: Copy>(a: &Animated<T>, default: T) -> T {
        match a {
            Animated::Static(v) => *v,
            Animated::Keyframed(kfs) => kfs.front().map(|k| k.value).unwrap_or(default),
        }
    }
    match params {
        LayerParams::VideoClip(p) => (
            static_or(&p.opacity, 1.0),
            static_or(&p.transform.x, 0.0),
            static_or(&p.transform.y, 0.0),
            static_or(&p.transform.scale_x, 1.0),
            static_or(&p.transform.scale_y, 1.0),
        ),
        LayerParams::ImageOverlay(p) => (
            static_or(&p.opacity, 1.0),
            static_or(&p.transform.x, 0.0),
            static_or(&p.transform.y, 0.0),
            static_or(&p.transform.scale_x, 1.0),
            static_or(&p.transform.scale_y, 1.0),
        ),
        LayerParams::Text(p) => (
            static_or(&p.opacity, 1.0),
            static_or(&p.transform.x, 0.0),
            static_or(&p.transform.y, 0.0),
            static_or(&p.transform.scale_x, 1.0),
            static_or(&p.transform.scale_y, 1.0),
        ),
        LayerParams::Color(_) => (1.0, 0.0, 0.0, 1.0, 1.0),
        _ => (1.0, 0.0, 0.0, 1.0, 1.0),
    }
}

/// Variant of `composition_params` that also fills VideoClip /
/// ImageOverlay export fields (`frame_pattern` + `frame_count` /
/// `image_src`) and appends a matching `VideoSource` to the
/// extraction list. Called per-member from `materialize_html_groups`.
fn composition_params_for_export(
    layer: &crate::state::layer::Layer,
    project: &crate::state::project::Project,
    canvas_w: u32,
    canvas_h: u32,
    fps_num: u32,
    fps_den: u32,
    sources: &mut Vec<crate::raster::html_group::VideoSource>,
) -> crate::raster::composition::CompositionLayerParams {
    use crate::raster::composition::CompositionLayerParams;
    use crate::raster::html_group::{VideoSource, VideoSourceKind};
    use crate::state::layer::LayerParams;

    match &layer.params {
        LayerParams::VideoClip(p) => {
            // Same native-dims lookup as `composition_params` (kept inline
            // because we also need the media's `path_abs` for extraction).
            let (w, h, path_abs) = project
                .media_pool
                .get(&p.media)
                .map(|m| {
                    let dims = m
                        .metadata
                        .video
                        .as_ref()
                        .map(|v| (v.width, v.height))
                        .unwrap_or((canvas_w, canvas_h));
                    (dims.0, dims.1, Some(m.path_abs.clone()))
                })
                .unwrap_or((canvas_w, canvas_h, None));

            let frame_count = crate::raster::source_frames::frame_count(
                p.src_in_us,
                p.src_out_us,
                fps_num,
                fps_den,
            );
            let lid = layer.id.to_string();
            let frame_pattern = format!("source/{}/frame_%05d.png", lid);

            if let Some(media_path) = path_abs {
                sources.push(VideoSource {
                    layer_id: lid,
                    media_path,
                    kind: VideoSourceKind::Video {
                        src_in_us: p.src_in_us,
                        src_out_us: p.src_out_us,
                    },
                });
            }

            CompositionLayerParams::VideoClip {
                media_id: p.media.to_string(),
                src_in_us: p.src_in_us,
                src_out_us: p.src_out_us,
                width: w,
                height: h,
                frame_pattern: Some(frame_pattern),
                frame_count: Some(frame_count),
            }
        }
        LayerParams::ImageOverlay(p) => {
            let (w, h, path_abs) = project
                .media_pool
                .get(&p.media)
                .map(|m| {
                    let dims = m
                        .metadata
                        .video
                        .as_ref()
                        .map(|v| (v.width, v.height))
                        .unwrap_or((canvas_w, canvas_h));
                    (dims.0, dims.1, Some(m.path_abs.clone()))
                })
                .unwrap_or((canvas_w, canvas_h, None));

            let lid = layer.id.to_string();
            let image_src = format!("source/{}/frame_00000.png", lid);

            if let Some(media_path) = path_abs {
                sources.push(VideoSource {
                    layer_id: lid,
                    media_path,
                    kind: VideoSourceKind::Image,
                });
            }

            CompositionLayerParams::ImageOverlay {
                media_id: p.media.to_string(),
                width: w,
                height: h,
                image_src: Some(image_src),
            }
        }
        LayerParams::Template(_) => {
            // Embed the parsed template artifacts directly into the
            // composition state. The engine will attachShadow on the
            // placeholder host and run the scripts with per-instance
            // shadowed globals — matching the preview-side path.
            template_composition_params(&layer.params, canvas_w, canvas_h)
        }
        // Other kinds fall through to the simpler helper.
        _ => composition_params(&layer.params, project, canvas_w, canvas_h),
    }
}

/// Build the `CompositionLayerParams::Template` for a Template layer,
/// looking up the template, validating + canonicalizing props, composing
/// the HTML, and extracting style/scripts/body via
/// `parse_composed_template`. On any lookup or validation failure,
/// returns a `Color` placeholder so the export doesn't hard-fail (a
/// missing template at export time has already been flagged by the
/// validator at edit time).
fn template_composition_params(
    params: &crate::state::layer::LayerParams,
    canvas_w: u32,
    canvas_h: u32,
) -> crate::raster::composition::CompositionLayerParams {
    use crate::raster::composition::{CompositionLayerParams, Rgba8};
    use crate::raster::template::{builtins, parse_composed_template};
    use crate::state::layer::LayerParams;

    let LayerParams::Template(p) = params else {
        return CompositionLayerParams::Color {
            rgba: Rgba8 { r: 0, g: 0, b: 0, a: 0 },
            width: 1,
            height: 1,
        };
    };

    let Some(tpl) = builtins().into_iter().find(|t| t.id() == p.template_id) else {
        tracing::warn!(
            "composition: template `{}` not in builtins catalog — emitting placeholder",
            p.template_id,
        );
        return CompositionLayerParams::Color {
            rgba: Rgba8 { r: 0, g: 0, b: 0, a: 0 },
            width: 1,
            height: 1,
        };
    };

    // Convert imbl::HashMap<String, Value> → serde_json::Value::Object
    // so canonicalize_props sees the expected shape.
    let provided = serde_json::Value::Object(
        p.props
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    );
    let canonical_json = match tpl.canonicalize_props(&provided) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "composition: template `{}` prop validation failed: {} — emitting placeholder",
                p.template_id,
                e,
            );
            return CompositionLayerParams::Color {
                rgba: Rgba8 { r: 0, g: 0, b: 0, a: 0 },
                width: 1,
                height: 1,
            };
        }
    };
    let props_value: serde_json::Value =
        serde_json::from_str(&canonical_json).unwrap_or(serde_json::Value::Object(Default::default()));

    let composed = tpl.html.replace("__STYLE__", &tpl.style);
    let parsed = parse_composed_template(&composed);

    let (w, h) = tpl.size();
    let _ = (canvas_w, canvas_h); // unused — template sizes itself off the manifest

    CompositionLayerParams::Template {
        template_id: tpl.id().to_string(),
        style: parsed.style,
        scripts: parsed.scripts,
        body: parsed.body,
        props: props_value,
        width: w,
        height: h,
    }
}

fn composition_params(
    params: &crate::state::layer::LayerParams,
    project: &crate::state::project::Project,
    canvas_w: u32,
    canvas_h: u32,
) -> crate::raster::composition::CompositionLayerParams {
    use crate::raster::composition::{CompositionLayerParams, Rgba8};
    use crate::state::animated::Animated;
    use crate::state::color::Rgba;
    use crate::state::ids::MediaId;
    use crate::state::layer::LayerParams;

    fn static_rgba(a: &Animated<Rgba>) -> Rgba {
        match a {
            Animated::Static(v) => *v,
            Animated::Keyframed(kfs) => kfs.front().map(|k| k.value).unwrap_or(Rgba::BLACK),
        }
    }

    // Native dims for a media id with `canvas_w`/`canvas_h` fallback.
    // ImageOverlay encodes its single frame under `metadata.video`
    // (same `VideoStreamMeta` shape) so this works for both kinds.
    let media_dims = |media_id: MediaId| -> (u32, u32) {
        project
            .media_pool
            .get(&media_id)
            .and_then(|m| m.metadata.video.as_ref())
            .map(|v| (v.width, v.height))
            .unwrap_or((canvas_w, canvas_h))
    };

    match params {
        LayerParams::Color(p) => CompositionLayerParams::Color {
            rgba: rgba_to_8(static_rgba(&p.color)),
            width: p.width,
            height: p.height,
        },
        LayerParams::Text(p) => CompositionLayerParams::Text {
            content: p.content.clone(),
            font_family: p.font.family.clone(),
            font_size_px: p.font.size_px as f64,
            color: rgba_to_8(static_rgba(&p.color)),
        },
        LayerParams::VideoClip(p) => {
            let (w, h) = media_dims(p.media);
            CompositionLayerParams::VideoClip {
                media_id: p.media.to_string(),
                src_in_us: p.src_in_us,
                src_out_us: p.src_out_us,
                width: w,
                height: h,
                frame_pattern: None,
                frame_count: None,
            }
        }
        LayerParams::ImageOverlay(p) => {
            let (w, h) = media_dims(p.media);
            CompositionLayerParams::ImageOverlay {
                media_id: p.media.to_string(),
                width: w,
                height: h,
                image_src: None,
            }
        }
        // Defensive — caller filtered these out.
        LayerParams::Audio(_) | LayerParams::Template(_) | LayerParams::Subtitles(_) => {
            CompositionLayerParams::Color {
                rgba: Rgba8 { r: 0, g: 0, b: 0, a: 0 },
                width: 1,
                height: 1,
            }
        }
    }
}

fn rgba_to_8(c: crate::state::color::Rgba) -> crate::raster::composition::Rgba8 {
    crate::raster::composition::Rgba8 { r: c.r, g: c.g, b: c.b, a: c.a }
}

/// Find the group's first enabled `HtmlTransform` effect and convert
/// its `Animated<f64>` tracks into the engine-facing `CompositionTransform`.
/// Returns `None` when the group has no `HtmlTransform` — the engine
/// then writes no transform to `#composition`, matching the no-effect
/// ffmpeg render exactly. Mirrors `pickCompositionTransform` in TS
/// `distill.ts`.
fn pick_composition_transform(
    group: &crate::state::group::Group,
) -> Option<crate::raster::composition::CompositionTransform> {
    pick_html_transform(group.effects.iter())
}

/// Walk an effect chain and return the first enabled `Blur`'s radius
/// track as a `CompositionFilter`. Returns `None` when the chain has no
/// `Blur` effect. Mirrors `pickBlur` in TS `distill.ts`. Multi-Blur in
/// one chain isn't supported in v1 (the first wins).
fn pick_blur<'a, I>(effects: I) -> Option<crate::raster::composition::CompositionFilter>
where
    I: IntoIterator<Item = &'a crate::state::effect::Effect>,
{
    use crate::state::effect::EffectParams;
    for e in effects {
        if !e.enabled {
            continue;
        }
        if let EffectParams::Blur { radius } = &e.params {
            return Some(crate::raster::composition::CompositionFilter {
                blur_px: radius.clone(),
            });
        }
    }
    None
}

/// Walk an effect chain (group or layer) and return the first enabled
/// `HtmlTransform`'s tracks as a `CompositionTransform`. Returns
/// `None` when the chain has no `HtmlTransform`. Multi-HtmlTransform
/// in one chain isn't supported in v1 (the first wins). Mirrors
/// `pickHtmlTransform` in TS `distill.ts`.
fn pick_html_transform<'a, I>(effects: I) -> Option<crate::raster::composition::CompositionTransform>
where
    I: IntoIterator<Item = &'a crate::state::effect::Effect>,
{
    use crate::state::effect::EffectParams;
    for e in effects {
        if !e.enabled {
            continue;
        }
        if let EffectParams::HtmlTransform {
            x,
            y,
            scale_x,
            scale_y,
            rotation_deg,
            opacity,
        } = &e.params
        {
            return Some(crate::raster::composition::CompositionTransform {
                x: x.clone(),
                y: y.clone(),
                scale_x: scale_x.clone(),
                scale_y: scale_y.clone(),
                rotation_deg: rotation_deg.clone(),
                opacity: opacity.clone(),
            });
        }
    }
    None
}

fn layer_kind_str(params: &crate::state::layer::LayerParams) -> &'static str {
    use crate::state::layer::LayerParams;
    match params {
        LayerParams::VideoClip(_) => "VideoClip",
        LayerParams::ImageOverlay(_) => "ImageOverlay",
        LayerParams::Text(_) => "Text",
        LayerParams::Color(_) => "Color",
        LayerParams::Audio(_) => "Audio",
        LayerParams::Template(_) => "Template",
        LayerParams::Subtitles(_) => "Subtitles",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::layer::SubtitlesParams;
    use crate::state::project::Project;
    use crate::state::{Layer, LayerParams};
    use tempfile::TempDir;

    fn add_subtitle_layer(project: &mut Project, source: SubtitlesSource) -> LayerId {
        let layer = Layer {
            id: crate::state::ids::new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Subtitles(SubtitlesParams { source }),
            effects: imbl::Vector::new(),
        };
        // Find or pretend to find a video track; for this test we just push
        // onto the first track regardless of kind.
        let first = project.tracks.front_mut().unwrap();
        first.layers.push_back(layer.clone());
        layer.id
    }

    #[test]
    fn empty_project_returns_empty_map() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let project = Project::new_blank("t");
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn inline_srt_writes_content_addressable_file() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let body = "1\n00:00:00,000 --> 00:00:02,000\nhello world\n";
        let id = add_subtitle_layer(
            &mut project,
            SubtitlesSource::InlineSrt(body.to_string()),
        );
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        let path = map.get(&id).unwrap();
        assert!(path.is_file());
        let on_disk = std::fs::read_to_string(path).unwrap();
        assert_eq!(on_disk, body);
        // Hash is part of the path
        let hash = blake3::hash(body.as_bytes()).to_hex().to_string();
        assert!(path.to_string_lossy().contains(&hash));
        assert_eq!(path.extension().unwrap(), "srt");
    }

    #[test]
    fn inline_ass_uses_ass_extension() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let id = add_subtitle_layer(
            &mut project,
            SubtitlesSource::InlineAss("[Script Info]\n".to_string()),
        );
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        let path = map.get(&id).unwrap();
        assert_eq!(path.extension().unwrap(), "ass");
    }

    #[test]
    fn skips_when_already_cached() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let body = "1\n00:00:00,000 --> 00:00:02,000\nx\n";
        let _ = add_subtitle_layer(
            &mut project,
            SubtitlesSource::InlineSrt(body.to_string()),
        );
        let map1 = materialize_inline_subtitles(&project, &cache).unwrap();
        let path = map1.values().next().unwrap().clone();
        let mtime1 = std::fs::metadata(&path).unwrap().modified().unwrap();
        // Re-run; file should not be rewritten (mtime unchanged).
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = materialize_inline_subtitles(&project, &cache).unwrap();
        let mtime2 = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "skip-if-cached should not rewrite");
    }

    #[test]
    fn media_source_is_ignored() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let _ = add_subtitle_layer(
            &mut project,
            SubtitlesSource::Media(crate::state::ids::new_id()),
        );
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        assert!(map.is_empty());
    }
}
