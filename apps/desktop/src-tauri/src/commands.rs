//! Tauri command surface — the React UI's view onto the project actor.
//!
//! Design intent: keep these wrappers thin. The actor + handle hold all logic;
//! commands just translate UI calls into actor messages and shape responses for
//! the webview. As the mutation surface grows, mirror handle methods 1:1 here.

use serde::Serialize;
use tauri::State;

use std::path::PathBuf;

use chrono::Utc;

use uuid::Uuid;

use crate::export;
use crate::io;
use crate::ir;
use crate::mpv;
use crate::state::{
    self, Actor, ColorParams, CommandError, LayerParams, MediaItem, MediaKind, ProjectHandle,
    Rgba, TrackKind,
    actor::{CompositionPatch, LayerPatch},
    animated::Animated,
    ids::new_id,
    time::{Rational, TimeUs},
};

#[derive(Serialize, Clone)]
pub struct ProjectSummary {
    pub project_id: String,
    pub name: String,
    pub composition: CompositionSummary,
    pub track_count: usize,
    pub layer_count: usize,
    pub duration_us: i64,
    pub history: HistoryView,
    pub media: Vec<MediaSummary>,
    pub tracks: Vec<TrackSummary>,
}

#[derive(Serialize, Clone)]
pub struct TrackSummary {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    pub enabled: bool,
    pub locked: bool,
    pub layers: Vec<LayerSummary>,
}

#[derive(Serialize, Clone)]
pub struct LayerSummary {
    pub id: String,
    pub label: Option<String>,
    pub t_start_us: i64,
    pub t_end_us: i64,
    /// Discriminant of LayerParams ("VideoClip", "Color", "Audio", ...).
    pub kind: String,
    /// Optional hex `#rrggbb` derived from the layer's content (e.g. ColorParams)
    /// or a stable hash of the layer id for visual differentiation.
    pub color_hint: String,
    pub enabled: bool,
    pub locked: bool,
}

#[derive(Serialize, Clone)]
pub struct MediaSummary {
    pub id: String,
    pub label: String,
    pub path: String,
    pub kind: String,
    pub duration_us: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct CompositionSummary {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

#[derive(Serialize, Clone)]
pub struct HistoryView {
    pub cursor: usize,
    pub len: usize,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[tauri::command]
pub fn ping() -> &'static str {
    "ok"
}

#[tauri::command]
pub async fn project_summary(handle: State<'_, ProjectHandle>) -> Result<ProjectSummary, ()> {
    let snap = handle.snapshot().await;
    let history = handle.history_status().await;
    let layer_count = snap.tracks.iter().map(|t| t.layers.len()).sum();

    let mut media: Vec<MediaSummary> = snap
        .media_pool
        .values()
        .map(|m| {
            let label = m
                .label
                .clone()
                .or_else(|| {
                    m.path_abs
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| m.path_abs.to_string_lossy().to_string());
            MediaSummary {
                id: m.id.to_string(),
                label,
                path: m.path_abs.to_string_lossy().to_string(),
                kind: format!("{:?}", m.kind),
                duration_us: m.metadata.duration_us,
                width: m.metadata.video.as_ref().map(|v| v.width),
                height: m.metadata.video.as_ref().map(|v| v.height),
                size_bytes: m.file_size,
            }
        })
        .collect();
    // Stable display order: most recently imported first.
    media.sort_by(|a, b| b.id.cmp(&a.id));

    let tracks: Vec<TrackSummary> = snap
        .tracks
        .iter()
        .map(|t| TrackSummary {
            id: t.id.to_string(),
            kind: format!("{:?}", t.kind),
            label: t.label.clone(),
            enabled: t.enabled,
            locked: t.locked,
            layers: t
                .layers
                .iter()
                .map(|l| LayerSummary {
                    id: l.id.to_string(),
                    label: l.label.clone(),
                    t_start_us: l.t_start_us,
                    t_end_us: l.t_end_us,
                    kind: layer_kind(&l.params),
                    color_hint: layer_color_hint(l),
                    enabled: l.enabled,
                    locked: l.locked,
                })
                .collect(),
        })
        .collect();

    Ok(ProjectSummary {
        project_id: snap.project_id.to_string(),
        name: snap.metadata.name.clone(),
        composition: CompositionSummary {
            width: snap.composition.width,
            height: snap.composition.height,
            fps_num: snap.composition.fps.num,
            fps_den: snap.composition.fps.den,
        },
        track_count: snap.tracks.len(),
        layer_count,
        duration_us: snap.composition.duration_us,
        history: HistoryView {
            cursor: history.cursor,
            len: history.len,
            can_undo: history.can_undo,
            can_redo: history.can_redo,
        },
        media,
        tracks,
    })
}

fn layer_kind(params: &LayerParams) -> String {
    match params {
        LayerParams::VideoClip(_) => "VideoClip",
        LayerParams::ImageOverlay(_) => "ImageOverlay",
        LayerParams::Text(_) => "Text",
        LayerParams::Template(_) => "Template",
        LayerParams::Audio(_) => "Audio",
        LayerParams::Subtitles(_) => "Subtitles",
        LayerParams::Color(_) => "Color",
    }
    .to_string()
}

fn layer_color_hint(layer: &crate::state::Layer) -> String {
    // Prefer the actual ColorParams color when the layer is a Color clip; otherwise
    // derive a stable color from the layer id so blocks look distinct.
    if let LayerParams::Color(p) = &layer.params {
        let rgba = match &p.color {
            crate::state::Animated::Static(c) => *c,
            crate::state::Animated::Keyframed(kfs) => {
                kfs.iter().next().map(|kf| kf.value).unwrap_or(crate::state::Rgba::BLACK)
            }
        };
        return format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b);
    }
    // Hash the UUID bytes for a stable hue.
    let bytes = layer.id.as_bytes();
    let hue = ((bytes[0] as u32) << 8 | bytes[1] as u32) % 360;
    hsl_to_hex(hue as f32, 0.55, 0.55)
}

fn hsl_to_hex(h: f32, s: f32, l: f32) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match h as u32 {
        0..=59 => (c, x, 0.0),
        60..=119 => (x, c, 0.0),
        120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c),
        240..=299 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    format!(
        "#{:02x}{:02x}{:02x}",
        ((r + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b + m) * 255.0).round().clamp(0.0, 255.0) as u8,
    )
}

#[tauri::command]
pub async fn add_video_track(handle: State<'_, ProjectHandle>) -> Result<String, String> {
    let id = handle
        .add_track(Actor::User, TrackKind::Video, Some("Video".into()))
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok(id.to_string())
}

#[tauri::command]
pub async fn add_media_layer(
    handle: State<'_, ProjectHandle>,
    track_id: String,
    media_id: String,
    t_start_us: TimeUs,
) -> Result<String, String> {
    let track = Uuid::parse_str(&track_id).map_err(|e| format!("track_id: {e}"))?;
    let media = Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;

    let snap = handle.snapshot().await;
    let media_item = snap
        .media_pool
        .get(&media)
        .ok_or_else(|| "media not found in pool".to_string())?;

    // Default duration when ffprobe wasn't able to fill it in: 2 seconds. Lets
    // image / unprobed-clip drops still produce a placeable block.
    let total_src = media_item.metadata.duration_us.unwrap_or(2_000_000);

    let (params, span_us) = match media_item.kind {
        MediaKind::Video => (
            LayerParams::VideoClip(state::layer::VideoClipParams {
                media,
                src_in_us: 0,
                src_out_us: total_src,
                transform: Default::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
            }),
            total_src,
        ),
        MediaKind::Audio => (
            LayerParams::Audio(state::layer::AudioParams {
                media,
                src_in_us: 0,
                src_out_us: total_src,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
            }),
            total_src,
        ),
        MediaKind::Image => (
            LayerParams::ImageOverlay(state::layer::ImageOverlayParams {
                media,
                transform: Default::default(),
                opacity: Animated::Static(1.0),
                blend_mode: Default::default(),
            }),
            // Stills: default to 3 seconds of screen time.
            3_000_000,
        ),
        MediaKind::Subtitle => {
            return Err("subtitle media drop is not supported yet".to_string());
        }
    };

    let t_end_us = t_start_us + span_us;

    handle
        .add_layer(Actor::User, track, params, t_start_us, t_end_us)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn add_demo_color_layer(handle: State<'_, ProjectHandle>) -> Result<String, String> {
    let snap = handle.snapshot().await;
    // Find or create a video track.
    let track_id = match snap
        .tracks
        .iter()
        .find(|t| matches!(t.kind, TrackKind::Video))
    {
        Some(t) => t.id,
        None => handle
            .add_track(Actor::User, TrackKind::Video, Some("Video".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };
    // Append after the last layer on that track (or start at 0).
    let snap = handle.snapshot().await;
    let track = snap
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .expect("track just created");
    let t_start = track.layers.last().map(|l| l.t_end_us).unwrap_or(0);
    let t_end = t_start + 2_000_000; // 2s

    let params = LayerParams::Color(ColorParams {
        color: Animated::Static(demo_color(track.layers.len())),
        width: snap.composition.width,
        height: snap.composition.height,
    });

    let layer_id = handle
        .add_layer(Actor::User, track_id, params, t_start, t_end)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok(layer_id.to_string())
}

#[tauri::command]
pub async fn project_undo(handle: State<'_, ProjectHandle>) -> Result<(), String> {
    handle
        .undo(Actor::User)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn split_first_layer(handle: State<'_, ProjectHandle>) -> Result<(), String> {
    // Demo helper for the UI: find the topmost layer with duration > 200ms and
    // split it at its midpoint. Production would let the user pick the layer +
    // split time on the timeline; that's Phase 1.8 UI work.
    let snap = handle.snapshot().await;
    for track in snap.tracks.iter() {
        for layer in track.layers.iter() {
            let duration = layer.t_end_us - layer.t_start_us;
            if duration > 200_000 {
                let mid = layer.t_start_us + duration / 2;
                handle
                    .split_layer(Actor::User, layer.id, mid)
                    .await
                    .map_err(|e: CommandError| e.to_string())?;
                return Ok(());
            }
        }
    }
    Err("no splittable layer (need at least 200ms)".to_string())
}

#[tauri::command]
pub async fn project_save_as(
    handle: State<'_, ProjectHandle>,
    path: String,
) -> Result<(), String> {
    let snap = handle.snapshot().await;
    let path = PathBuf::from(path);
    io::save_to_dir(&snap, &path)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn project_open(
    handle: State<'_, ProjectHandle>,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let project = io::load_from_dir(&path)
        .await
        .map_err(|e| format!("{e:#}"))?;
    handle
        .replace_state(Actor::User, project)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct CompiledGraph {
    pub inputs: Vec<String>,
    pub filter_graph: String,
    pub maps: Vec<String>,
    pub node_count: usize,
}

#[tauri::command]
pub async fn import_media(
    handle: State<'_, ProjectHandle>,
    path: String,
) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    let item = tokio::task::spawn_blocking(move || -> Result<MediaItem, String> {
        let facts = io::probe::hash_and_stat(&path_buf).map_err(|e| format!("{e:#}"))?;
        let metadata = io::probe::probe_metadata(&path_buf);
        let kind: MediaKind = io::probe::detect_kind(&path_buf, &metadata);
        let label = path_buf
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        Ok(MediaItem {
            id: new_id(),
            label,
            path_abs: path_buf,
            path_rel: None,
            kind,
            metadata,
            proxy_path: None,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: facts.blake3_hex,
            file_size: facts.size,
            file_mtime: facts.mtime_secs,
            imported_at: Utc::now(),
        })
    })
    .await
    .map_err(|e| format!("import join: {e}"))??;

    handle
        .add_media_item(Actor::User, item)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn compile_project(
    handle: State<'_, ProjectHandle>,
) -> Result<CompiledGraph, String> {
    let snap = handle.snapshot().await;
    let target = ir::RenderTarget::full(
        snap.composition.width,
        snap.composition.height,
        Rational::new(snap.composition.fps.num, snap.composition.fps.den),
        snap.composition.sample_rate,
        snap.composition.channels,
    );
    let graph = ir::lower(&snap, target).map_err(|e| e.to_string())?;
    let plan = ir::emit_ffmpeg(&graph);
    Ok(CompiledGraph {
        inputs: plan.inputs,
        filter_graph: plan.filter_graph,
        maps: plan.maps,
        node_count: graph.nodes.len(),
    })
}

#[tauri::command]
pub async fn update_layer(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
    patch: LayerPatch,
) -> Result<(), String> {
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .update_layer(Actor::User, id, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn move_layer(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
    new_track_id: String,
    new_t_start_us: TimeUs,
) -> Result<(), String> {
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let tid = Uuid::parse_str(&new_track_id).map_err(|e| format!("new_track_id: {e}"))?;
    handle
        .move_layer(Actor::User, lid, tid, new_t_start_us)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn delete_layer(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .delete_layer(Actor::User, id)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn duplicate_layer(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
    t_offset_us: TimeUs,
) -> Result<String, String> {
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .duplicate_layer(Actor::User, id, t_offset_us)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn set_composition(
    handle: State<'_, ProjectHandle>,
    patch: CompositionPatch,
) -> Result<(), String> {
    handle
        .set_composition(Actor::User, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn add_marker(
    handle: State<'_, ProjectHandle>,
    t_us: TimeUs,
    end_t_us: Option<TimeUs>,
    label: String,
    color: Rgba,
) -> Result<String, String> {
    handle
        .add_marker(Actor::User, t_us, end_t_us, label, color)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

/// Open the libmpv preview window and play the given file. Spawns libmpv on
/// first call. Phase 1 mode is a standalone top-level window; the
/// embed-inside-Tauri-window slice is follow-on work.
#[tauri::command]
pub async fn mpv_play_file(
    slot: tauri::State<'_, mpv::MpvSlot>,
    path: String,
) -> Result<(), String> {
    let slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || mpv::play_file(&slot, &path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn mpv_seek(
    slot: tauri::State<'_, mpv::MpvSlot>,
    t_us: TimeUs,
) -> Result<(), String> {
    let slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || mpv::seek(&slot, t_us))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn mpv_set_paused(
    slot: tauri::State<'_, mpv::MpvSlot>,
    paused: bool,
) -> Result<(), String> {
    let slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || mpv::set_paused(&slot, paused))
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// Close the libmpv preview window and drop the player handle. Idempotent —
/// safe to call when no preview is open.
#[tauri::command]
pub async fn mpv_close_preview(
    slot: tauri::State<'_, mpv::MpvSlot>,
) -> Result<(), String> {
    let slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || mpv::close(&slot))
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// Compile the current project to an `MpvPlan` and load it into the libmpv
/// preview window. This is the "scrub the result, not the raw clip" path.
/// Returns a short status struct so the UI can confirm what was loaded.
#[derive(Serialize, Clone)]
pub struct MpvPreviewStatus {
    pub primary: Option<String>,
    pub external_count: usize,
    pub has_video: bool,
    pub has_audio: bool,
    pub graph_len: usize,
}

#[tauri::command]
pub async fn mpv_preview_project(
    handle: State<'_, ProjectHandle>,
    slot: tauri::State<'_, mpv::MpvSlot>,
) -> Result<MpvPreviewStatus, String> {
    let snap = handle.snapshot().await;
    let target = ir::RenderTarget::full(
        snap.composition.width,
        snap.composition.height,
        Rational::new(snap.composition.fps.num, snap.composition.fps.den),
        snap.composition.sample_rate,
        snap.composition.channels,
    );
    let graph = ir::lower(&snap, target).map_err(|e| e.to_string())?;
    let plan = ir::emit_mpv(&graph);
    let status = MpvPreviewStatus {
        primary: plan.primary.clone(),
        external_count: plan.external_files.len(),
        has_video: plan.has_video,
        has_audio: plan.has_audio,
        graph_len: plan.lavfi_complex.len(),
    };
    let slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || mpv::play_graph(&slot, &plan))
        .await
        .map_err(|e| format!("join: {e}"))??;
    Ok(status)
}

/// Resolve a `MediaId` to its absolute path and open it in the preview window.
#[tauri::command]
pub async fn mpv_play_media(
    handle: State<'_, ProjectHandle>,
    slot: tauri::State<'_, mpv::MpvSlot>,
    media_id: String,
) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let item = snap
        .media_pool
        .get(&id)
        .ok_or_else(|| "media not found in pool".to_string())?;
    let path = item.path_abs.to_string_lossy().to_string();
    let slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || mpv::play_file(&slot, &path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// Kicks off a render in the background. Progress / completion / failure are
/// surfaced via Tauri events (`export:progress`, `export:complete`,
/// `export:error`) so the UI can subscribe instead of awaiting.
#[tauri::command]
pub async fn export_project(
    app: tauri::AppHandle,
    handle: State<'_, ProjectHandle>,
    output_path: String,
) -> Result<(), String> {
    let snap = handle.snapshot().await;
    let path = PathBuf::from(output_path);
    let project = (*snap).clone();
    tauri::async_runtime::spawn(async move {
        export::export_to_mp4_logged(app, &project, path).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn project_redo(handle: State<'_, ProjectHandle>) -> Result<(), String> {
    handle
        .redo(Actor::User)
        .await
        .map_err(|e: CommandError| e.to_string())
}

fn demo_color(idx: usize) -> Rgba {
    // Cycle through a small accent palette so successive layers are visually distinct.
    const PALETTE: [Rgba; 6] = [
        Rgba::rgb(96, 165, 250),  // blue
        Rgba::rgb(244, 114, 182), // pink
        Rgba::rgb(74, 222, 128),  // green
        Rgba::rgb(251, 191, 36),  // amber
        Rgba::rgb(167, 139, 250), // violet
        Rgba::rgb(248, 113, 113), // red
    ];
    PALETTE[idx % PALETTE.len()]
}

