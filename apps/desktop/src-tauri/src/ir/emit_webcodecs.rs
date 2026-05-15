//! Phase B3 — WebCodecs composition recipe emitter.
//!
//! Unlike `emit_ffmpeg` / `emit_mpv`, which compile an `IRGraph` into a
//! lavfi filter graph, `emit_webcodecs` walks the `Project` directly
//! and produces a high-level JSON composition recipe that the
//! frontend's WebGL2 compositor + WebCodecs decoder pool consume at
//! playback time.
//!
//! The recipe is declarative and time-parameterized: it enumerates
//! clips, raster layers (materialized templates), and image overlays
//! with their timeline ranges, transforms, opacity, and blend mode.
//! The frontend resolves "at output time t, which layers are active?"
//! by linear scan and feeds the resulting layer set into B2's
//! `WebGL2Compositor`.
//!
//! Why walk Project, not IRGraph: the existing IR is shaped for
//! lavfi — `Color` / `DecodeV` / `Scale` / `Fps` / `SetPts` / `Overlay`
//! — and unwinding those into per-layer transforms would be more
//! complex than reading the Project's layer params directly. The
//! "one IR, many emit targets" promise covers ffmpeg + mpv (both
//! lavfi-shaped); the WebCodecs target lives parallel to that.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ir::materialize::{TemplateRenderInfo, TemplateRenders};
use crate::ir::target::RenderTarget;
use crate::state::animated::Animated;
use crate::state::layer::{
    ImageOverlayParams, Layer, LayerParams, TemplateParams, VideoClipParams,
};
use crate::state::media::{MediaItem, MediaKind};
use crate::state::project::Project;
use crate::state::track::TrackKind;
use crate::state::transform::BlendMode as ProjectBlendMode;

/// Recipe schema version. Bump on any structural change so old
/// frontends can refuse to render rather than crash.
pub const RECIPE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcodecsRecipe {
    pub schema_version: u32,
    pub duration_us: i64,
    pub canvas: RecipeCanvas,
    /// Linear-space RGBA in [0, 1]. Frontend uses this as the
    /// compositor's clear color.
    pub background: [f32; 4],
    pub clips: Vec<RecipeClip>,
    pub rasters: Vec<RecipeRaster>,
    pub images: Vec<RecipeImage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeCanvas {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

/// Per-layer transform in canvas-normalized [0, 1] space, matching
/// `CompositorLayer.transform` on the frontend.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeTransform {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeClip {
    pub layer_id: Uuid,
    pub track_index: u32,
    pub z_order: i32,
    pub media_id: Uuid,
    /// Absolute path on disk. The frontend resolves to a fetchable
    /// URL via `convertFileSrc`.
    pub media_path: PathBuf,
    pub timeline_in_us: i64,
    pub timeline_out_us: i64,
    pub source_in_us: i64,
    pub source_out_us: i64,
    pub transform: RecipeTransform,
    pub opacity: f32,
    pub blend_mode: String,
    pub speed: f32,
    /// Always true for video clips — VideoFrame uploads bypass the
    /// compositor's global UNPACK_FLIP_Y_WEBGL in WebView2 (see B2 fix
    /// commit). The frontend honors this hint per-layer in the shader.
    pub flip_y: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRaster {
    pub layer_id: Uuid,
    pub track_index: u32,
    pub z_order: i32,
    /// Directory holding `frame_NNNNN.png`. The frontend builds
    /// per-frame URLs as `<raster_dir>/frame_00001.png` etc.
    pub raster_dir: PathBuf,
    pub frame_count: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub timeline_in_us: i64,
    pub timeline_out_us: i64,
    pub transform: RecipeTransform,
    pub opacity: f32,
    pub blend_mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeImage {
    pub layer_id: Uuid,
    pub track_index: u32,
    pub z_order: i32,
    pub media_id: Uuid,
    pub media_path: PathBuf,
    pub timeline_in_us: i64,
    pub timeline_out_us: i64,
    pub transform: RecipeTransform,
    pub opacity: f32,
    pub blend_mode: String,
}

/// Walk the Project and produce a composition recipe. The
/// `template_renders` map carries materialized raster info for
/// Template layers; pass `Default::default()` if templates haven't
/// been rendered yet (those layers are silently skipped — they'd
/// fall back to A's MSE path at playback time).
pub fn emit(
    project: &Project,
    target: &RenderTarget,
    template_renders: &TemplateRenders,
) -> WebcodecsRecipe {
    let canvas = RecipeCanvas {
        width: target.width,
        height: target.height,
        fps_num: target.fps.num,
        fps_den: target.fps.den,
    };

    let bg = project.composition.background;
    let background = [
        bg.r as f32 / 255.0,
        bg.g as f32 / 255.0,
        bg.b as f32 / 255.0,
        bg.a as f32 / 255.0,
    ];

    let mut clips = Vec::new();
    let mut rasters = Vec::new();
    let mut images = Vec::new();

    for (track_idx, track) in project.tracks.iter().enumerate() {
        if !track.enabled {
            continue;
        }
        if track.kind != TrackKind::Video {
            // Audio + subtitle tracks aren't WebCodecs-rendered:
            // audio reuses A's whole-timeline file; subtitles ride
            // the raster pipeline alongside templates.
            continue;
        }

        // Z-order: each later track renders on top. Stride by 1_000
        // so the in-track layer index could be folded in later
        // without renumbering.
        let z_order = (track_idx as i32) * 1_000;

        for layer in track.layers.iter() {
            if !layer.enabled {
                continue;
            }
            match &layer.params {
                LayerParams::VideoClip(p) => {
                    if let Some(media) = project.media_pool.get(&p.media) {
                        if media.kind == MediaKind::Video {
                            clips.push(build_video_clip(
                                layer, track_idx as u32, z_order, p, media, &canvas,
                            ));
                        }
                    }
                }
                LayerParams::ImageOverlay(p) => {
                    if let Some(media) = project.media_pool.get(&p.media) {
                        if media.kind == MediaKind::Image {
                            images.push(build_image(
                                layer, track_idx as u32, z_order, p, media, &canvas,
                            ));
                        }
                    }
                }
                LayerParams::Template(p) => {
                    if let Some(info) = template_renders.get(&layer.id) {
                        rasters.push(build_template_raster(
                            layer, track_idx as u32, z_order, p, info, &canvas,
                        ));
                    }
                    // Un-materialized template — frontend will route
                    // the layer through A's segmented cache at
                    // playback time (B6 logic).
                }
                // Text + Subtitles + Color + Audio: not in B3 scope.
                // Color compresses into the canvas background;
                // text / subtitles need rasterization on the same
                // path templates use, wired in a later pass.
                _ => {}
            }
        }
    }

    WebcodecsRecipe {
        schema_version: RECIPE_SCHEMA_VERSION,
        duration_us: project.composition.duration_us,
        canvas,
        background,
        clips,
        rasters,
        images,
    }
}

fn build_video_clip(
    layer: &Layer,
    track_index: u32,
    z_order: i32,
    params: &VideoClipParams,
    media: &MediaItem,
    canvas: &RecipeCanvas,
) -> RecipeClip {
    // Mirrors `emit_ffmpeg`'s VideoClip convention: `scale_x/y` are
    // fractions of the *canvas* (1.0 = fills canvas axis), and
    // `transform.x/y` is the top-left position in canvas pixels.
    // `anchor` is currently ignored (the existing IR ignores it too).
    let scale_x = static_or_f64(&params.transform.scale_x, 1.0);
    let scale_y = static_or_f64(&params.transform.scale_y, 1.0);
    let x_px = static_or_f64(&params.transform.x, 0.0);
    let y_px = static_or_f64(&params.transform.y, 0.0);
    let opacity = static_or_f64(&params.opacity, 1.0).clamp(0.0, 1.0) as f32;

    RecipeClip {
        layer_id: layer.id,
        track_index,
        z_order,
        media_id: params.media,
        media_path: media.path_abs.clone(),
        timeline_in_us: layer.t_start_us,
        timeline_out_us: layer.t_end_us,
        source_in_us: params.src_in_us,
        source_out_us: params.src_out_us,
        transform: RecipeTransform {
            x: (x_px / canvas.width as f64) as f32,
            y: (y_px / canvas.height as f64) as f32,
            width: scale_x as f32,
            height: scale_y as f32,
        },
        opacity,
        blend_mode: blend_to_string(params.blend_mode),
        speed: params.speed as f32,
        flip_y: true,
    }
}

fn build_image(
    layer: &Layer,
    track_index: u32,
    z_order: i32,
    params: &ImageOverlayParams,
    media: &MediaItem,
    canvas: &RecipeCanvas,
) -> RecipeImage {
    // `emit_ffmpeg` ignores ImageOverlay scale (image renders at
    // native size); we follow suit. Width/height come from the
    // image's natural metadata when available — fall back to
    // canvas-fill so the layer is at least visible without metadata.
    let (nat_w, nat_h) = media
        .metadata
        .video
        .as_ref()
        .map(|v| (v.width, v.height))
        .unwrap_or((canvas.width, canvas.height));
    let x_px = static_or_f64(&params.transform.x, 0.0);
    let y_px = static_or_f64(&params.transform.y, 0.0);
    let opacity = static_or_f64(&params.opacity, 1.0).clamp(0.0, 1.0) as f32;

    RecipeImage {
        layer_id: layer.id,
        track_index,
        z_order,
        media_id: params.media,
        media_path: media.path_abs.clone(),
        timeline_in_us: layer.t_start_us,
        timeline_out_us: layer.t_end_us,
        transform: RecipeTransform {
            x: (x_px / canvas.width as f64) as f32,
            y: (y_px / canvas.height as f64) as f32,
            width: (nat_w as f64 / canvas.width as f64) as f32,
            height: (nat_h as f64 / canvas.height as f64) as f32,
        },
        opacity,
        blend_mode: blend_to_string(params.blend_mode),
    }
}

fn build_template_raster(
    layer: &Layer,
    track_index: u32,
    z_order: i32,
    params: &TemplateParams,
    info: &TemplateRenderInfo,
    canvas: &RecipeCanvas,
) -> RecipeRaster {
    // Templates render at natural size * scale (lower.rs:531-557).
    // Raster frames live alongside `pattern_path` (the printf glob
    // points at the same directory).
    let scale_x = static_or_f64(&params.transform.scale_x, 1.0);
    let scale_y = static_or_f64(&params.transform.scale_y, 1.0);
    let x_px = static_or_f64(&params.transform.x, 0.0);
    let y_px = static_or_f64(&params.transform.y, 0.0);
    let opacity = static_or_f64(&params.opacity, 1.0).clamp(0.0, 1.0) as f32;

    let raster_dir = info
        .pattern_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default();

    RecipeRaster {
        layer_id: layer.id,
        track_index,
        z_order,
        raster_dir,
        frame_count: info.frame_count as u32,
        fps_num: info.fps_num,
        fps_den: info.fps_den,
        timeline_in_us: layer.t_start_us,
        timeline_out_us: layer.t_end_us,
        transform: RecipeTransform {
            x: (x_px / canvas.width as f64) as f32,
            y: (y_px / canvas.height as f64) as f32,
            width: ((info.width as f64 * scale_x) / canvas.width as f64) as f32,
            height: ((info.height as f64 * scale_y) / canvas.height as f64) as f32,
        },
        opacity,
        blend_mode: blend_to_string(ProjectBlendMode::Normal),
    }
}

fn static_or_f64(a: &Animated<f64>, fallback: f64) -> f64 {
    match a {
        Animated::Static(v) => *v,
        // B3 punts on animated values: keyframe interpolation lands
        // in B5 when the playback loop has a `t` to sample at. For
        // now we bake the fallback (typically the param's identity
        // value), so animated layers render with their resting pose.
        _ => fallback,
    }
}

fn blend_to_string(mode: ProjectBlendMode) -> String {
    match mode {
        ProjectBlendMode::Normal => "normal",
        ProjectBlendMode::Multiply => "multiply",
        ProjectBlendMode::Screen => "screen",
        ProjectBlendMode::Overlay => "overlay",
        ProjectBlendMode::Darken => "darken",
        ProjectBlendMode::Lighten => "lighten",
        ProjectBlendMode::Add => "add",
        ProjectBlendMode::Difference => "difference",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    use crate::state::{
        animated::Animated,
        color::Rgba,
        composition::Composition,
        layer::{ColorParams, Layer, LayerParams, VideoClipParams},
        media::{MediaItem, MediaKind, MediaMetadata, VideoStreamMeta},
        project::{Project, ProjectMetadata},
        time::Rational,
        track::{Track, TrackKind},
        transform::Transform,
    };

    fn target() -> RenderTarget {
        RenderTarget::full(1920, 1080, Rational::FPS_30, 48_000, 2)
    }

    fn empty_project() -> Project {
        Project {
            schema_version: 1,
            project_id: Uuid::nil(),
            metadata: ProjectMetadata {
                name: "test".into(),
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
            media_pool: imbl::HashMap::new(),
            tracks: imbl::Vector::new(),
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            settings: Default::default(),
        }
    }

    fn fixture_media(id: Uuid, path: &str, width: u32, height: u32) -> MediaItem {
        MediaItem {
            id,
            label: None,
            path_abs: path.into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width,
                    height,
                    fps_num: 30,
                    fps_den: 1,
                    codec: "h264".into(),
                    pix_fmt: "yuv420p".into(),
                }),
                audio: None,
            },
            proxy_path: None,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[test]
    fn empty_project_emits_empty_recipe() {
        let p = empty_project();
        let r = emit(&p, &target(), &Default::default());
        assert_eq!(r.schema_version, RECIPE_SCHEMA_VERSION);
        assert_eq!(r.duration_us, 5_000_000);
        assert_eq!(r.canvas.width, 1920);
        assert_eq!(r.canvas.height, 1080);
        assert!(r.clips.is_empty());
        assert!(r.rasters.is_empty());
        assert!(r.images.is_empty());
    }

    #[test]
    fn one_video_clip_emits_one_recipe_clip() {
        let media_id = Uuid::now_v7();
        let track_id = Uuid::now_v7();
        let layer_id = Uuid::now_v7();
        let media = fixture_media(media_id, "/m/v.mp4", 1920, 1080);

        let mut p = empty_project();
        p.media_pool.insert(media_id, media);
        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 1_000_000,
            t_end_us: 4_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 500_000,
                src_out_us: 3_500_000,
                transform: Transform::default(),
                opacity: Animated::Static(0.8),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: ProjectBlendMode::Normal,
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        };
        p.tracks.push_back(Track {
            id: track_id,
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![layer],
        });

        let r = emit(&p, &target(), &Default::default());
        assert_eq!(r.clips.len(), 1);
        let c = &r.clips[0];
        assert_eq!(c.layer_id, layer_id);
        assert_eq!(c.media_id, media_id);
        assert_eq!(c.timeline_in_us, 1_000_000);
        assert_eq!(c.timeline_out_us, 4_000_000);
        assert_eq!(c.source_in_us, 500_000);
        assert_eq!(c.source_out_us, 3_500_000);
        assert!((c.opacity - 0.8).abs() < 1e-5);
        // Default Transform: x=0,y=0,scale=1,1 → fills canvas.
        assert!((c.transform.x - 0.0).abs() < 1e-5);
        assert!((c.transform.y - 0.0).abs() < 1e-5);
        assert!((c.transform.width - 1.0).abs() < 1e-5);
        assert!((c.transform.height - 1.0).abs() < 1e-5);
        assert!(c.flip_y);
        assert_eq!(c.blend_mode, "normal");
    }

    #[test]
    fn disabled_track_skipped() {
        let media_id = Uuid::now_v7();
        let mut p = empty_project();
        p.media_pool
            .insert(media_id, fixture_media(media_id, "/m/x.mp4", 1920, 1080));
        let layer = Layer {
            id: Uuid::now_v7(),
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 1_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: ProjectBlendMode::Normal,
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        };
        p.tracks.push_back(Track {
            id: Uuid::now_v7(),
            kind: TrackKind::Video,
            label: None,
            enabled: false, // disabled — clips must be skipped
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![layer],
        });
        let r = emit(&p, &target(), &Default::default());
        assert!(r.clips.is_empty(), "disabled track should emit no clips");
    }

    #[test]
    fn audio_track_does_not_produce_clips() {
        let mut p = empty_project();
        p.tracks.push_back(Track {
            id: Uuid::now_v7(),
            kind: TrackKind::Audio,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 48,
            layers: imbl::Vector::new(),
        });
        let r = emit(&p, &target(), &Default::default());
        assert!(r.clips.is_empty());
    }

    #[test]
    fn pixel_transform_normalizes_to_canvas() {
        // transform.x=960 on a 1920-wide canvas → norm.x = 0.5
        let media_id = Uuid::now_v7();
        let mut p = empty_project();
        p.media_pool
            .insert(media_id, fixture_media(media_id, "/m/v.mp4", 1920, 1080));
        let mut transform = Transform::default();
        transform.x = Animated::Static(960.0);
        transform.y = Animated::Static(540.0);
        transform.scale_x = Animated::Static(0.5);
        transform.scale_y = Animated::Static(0.5);

        let layer = Layer {
            id: Uuid::now_v7(),
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 1_000_000,
                transform,
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: ProjectBlendMode::Normal,
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        };
        p.tracks.push_back(Track {
            id: Uuid::now_v7(),
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![layer],
        });

        let r = emit(&p, &target(), &Default::default());
        let c = &r.clips[0];
        assert!((c.transform.x - 0.5).abs() < 1e-5);
        assert!((c.transform.y - 0.5).abs() < 1e-5);
        assert!((c.transform.width - 0.5).abs() < 1e-5);
        assert!((c.transform.height - 0.5).abs() < 1e-5);
    }

    #[test]
    fn z_order_reflects_track_index() {
        let m1 = Uuid::now_v7();
        let m2 = Uuid::now_v7();
        let mut p = empty_project();
        p.media_pool.insert(m1, fixture_media(m1, "/m/a.mp4", 1920, 1080));
        p.media_pool.insert(m2, fixture_media(m2, "/m/b.mp4", 1920, 1080));

        let mk_clip = |media: Uuid| Layer {
            id: Uuid::now_v7(),
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media,
                src_in_us: 0,
                src_out_us: 1_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: ProjectBlendMode::Normal,
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        };

        p.tracks.push_back(Track {
            id: Uuid::now_v7(),
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![mk_clip(m1)],
        });
        p.tracks.push_back(Track {
            id: Uuid::now_v7(),
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![mk_clip(m2)],
        });

        let r = emit(&p, &target(), &Default::default());
        assert_eq!(r.clips.len(), 2);
        // Track 0 below track 1.
        assert!(r.clips[0].z_order < r.clips[1].z_order);
    }

    /// Color-layer Project doesn't produce clips — color collapses
    /// into the canvas background. The recipe is still well-formed.
    #[test]
    fn color_layer_emits_no_layers_but_recipe_is_valid() {
        let mut p = empty_project();
        let layer = Layer {
            id: Uuid::now_v7(),
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::WHITE),
                width: 1920,
                height: 1080,
            }),
        };
        p.tracks.push_back(Track {
            id: Uuid::now_v7(),
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![layer],
        });
        let r = emit(&p, &target(), &Default::default());
        assert!(r.clips.is_empty());
        assert!(r.images.is_empty());
        assert!(r.rasters.is_empty());
        assert_eq!(r.schema_version, RECIPE_SCHEMA_VERSION);
    }
}
