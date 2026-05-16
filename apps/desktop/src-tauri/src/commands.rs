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
use crate::raster::template as raster_template;
use crate::state::{
    self, Actor, ColorParams, CommandError, LayerParams, MediaItem, MediaKind, ProjectHandle,
    Rgba, SubtitlesParams, SubtitlesSource, TemplateParams, TrackKind, Transform,
    actor::{CompositionPatch, LayerParamsPatch, LayerPatch},
    animated::Animated,
    ids::new_id,
    time::{Rational, TimeUs},
    track::TrackRole,
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
    /// Sparse markers along the timeline. Surfaced so the agent-mode
    /// mini timeline can render them as pips above the scrub bar.
    pub markers: Vec<MarkerSummary>,
    /// Layer groups (`docs/group-system.md`). UI uses these to render the
    /// tinted group indicator + lookup the membership for click-selects-
    /// whole-group behavior.
    pub groups: Vec<GroupSummary>,
}

#[derive(Serialize, Clone)]
pub struct GroupSummary {
    pub id: String,
    pub label: Option<String>,
    pub layer_ids: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct MarkerSummary {
    pub id: String,
    pub t_us: i64,
    /// `Some(end)` when this is a region marker.
    pub end_t_us: Option<i64>,
    pub label: String,
    /// Hex `#rrggbb` derived from the marker's `color` field for
    /// straightforward CSS consumption.
    pub color_hint: String,
}

#[derive(Serialize, Clone)]
pub struct TrackSummary {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    pub enabled: bool,
    pub locked: bool,
    /// A/B-roll role stamp (`docs/ab-roll-redesign`). Serializes as the
    /// kebab-case variant name when present (`"a-roll" | "b-roll" |
    /// "audio-a" | "audio-b"`) or `null` for additional/legacy tracks. The
    /// UI uses this to drive the AB display-mode filter and the role-aware
    /// AV promotion path.
    pub role: Option<String>,
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
    /// UI-friendly snapshot of the kind-specific params. Read by the property
    /// panel; mutates flow back through `update_layer_params` with the
    /// matching `LayerParamsPatch` variant.
    pub params: LayerParamsView,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
pub enum LayerParamsView {
    VideoClip(VideoClipView),
    ImageOverlay(ImageOverlayView),
    Text(TextView),
    Color(ColorView),
    Audio(AudioView),
    Subtitles(SubtitlesView),
    Template { template_id: String },
}

#[derive(Serialize, Clone)]
pub struct VideoClipView {
    pub media_id: String,
    pub media_label: String,
    pub src_in_us: i64,
    pub src_out_us: i64,
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub opacity: f64,
    pub speed: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    pub fade_in_us: u64,
    pub fade_out_us: u64,
}

#[derive(Serialize, Clone)]
pub struct ImageOverlayView {
    pub media_id: String,
    pub media_label: String,
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub opacity: f64,
    pub fade_in_us: u64,
    pub fade_out_us: u64,
}

#[derive(Serialize, Clone)]
pub struct TextView {
    pub content: String,
    pub font_family: String,
    pub font_size_px: f32,
    pub color: Rgba,
    pub x: f64,
    pub y: f64,
    pub opacity: f64,
}

#[derive(Serialize, Clone)]
pub struct ColorView {
    pub color: Rgba,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Clone)]
pub struct AudioView {
    pub media_id: String,
    pub media_label: String,
    pub src_in_us: i64,
    pub src_out_us: i64,
    pub gain_db: f64,
    pub pan: f64,
    pub mute: bool,
}

#[derive(Serialize, Clone)]
pub struct SubtitlesView {
    pub source_kind: String,
    pub source_value: String,
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
    /// True when `path_abs` resolves to a real file on disk right now.
    /// Per workspace-redesign Q5/Q9, the UI shows a "missing media" badge
    /// when this is false (project opens anyway; layers referencing the
    /// missing item render placeholders).
    pub available: bool,
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
    /// `Some(reason)` while the agent has taken the revert lock.
    /// Frontend surfaces this as a badge in the agent-mode record
    /// panel header and as a disabled-tooltip on Undo / Redo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct McpInfoView {
    pub bind: String,
    pub sse_url: String,
    pub message_url: String,
    pub events_url: String,
    pub bearer_token: String,
}

/// Connect-agent panel reads this to render the connection snippet. Returns
/// `None` if the MCP server is still starting (panel shows "starting…").
#[tauri::command]
pub fn get_mcp_info(cell: State<'_, crate::mcp::McpInfoCell>) -> Option<McpInfoView> {
    cell.read().ok()?.as_ref().map(|info| McpInfoView {
        bind: info.bind.to_string(),
        sse_url: info.sse_url.clone(),
        message_url: info.message_url.clone(),
        events_url: info.events_url.clone(),
        bearer_token: info.bearer_token.clone(),
    })
}

/// Generate a fresh bearer token, swap it into the live `McpInfo`, and rewrite
/// `mcp_auth.json` so the next launch picks it up too. Port unchanged — the
/// server stays bound. Returns the new token for the UI to echo.
#[tauri::command]
pub fn reset_mcp_token(
    app: tauri::AppHandle,
    cell: State<'_, crate::mcp::McpInfoCell>,
) -> Result<String, String> {
    crate::mcp::regenerate_token(&app, &cell).map_err(|e| format!("reset bearer: {e:#}"))
}

#[tauri::command]
pub fn ping() -> &'static str {
    "ok"
}

#[derive(Serialize, Clone)]
pub struct ApiKeyStatus {
    pub provider: String,
    pub label: String,
    pub configured: bool,
}

/// Settings panel reads this to render which providers are configured. Never
/// returns key material — the keyring exposure stays one-way.
#[tauri::command]
pub fn settings_get_api_key_status() -> Vec<ApiKeyStatus> {
    crate::cloud::keys::Provider::all()
        .iter()
        .map(|p| ApiKeyStatus {
            provider: p.as_str().to_string(),
            label: p.label().to_string(),
            configured: crate::cloud::keys::has_key(*p),
        })
        .collect()
}

fn parse_provider(s: &str) -> Result<crate::cloud::keys::Provider, String> {
    match s {
        "openai" => Ok(crate::cloud::keys::Provider::OpenAi),
        other => Err(format!("unknown provider: {other}")),
    }
}

#[tauri::command]
pub fn settings_set_api_key(provider: String, key: String) -> Result<(), String> {
    let p = parse_provider(&provider)?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("api key is empty".into());
    }
    crate::cloud::keys::set_key(p, trimmed).map_err(|e| format!("keyring: {e}"))
}

#[tauri::command]
pub fn settings_clear_api_key(provider: String) -> Result<(), String> {
    let p = parse_provider(&provider)?;
    crate::cloud::keys::clear_key(p).map_err(|e| format!("keyring: {e}"))
}

/// Run a cheap API smoke check for the supplied provider. Returns a
/// structured `ConnectionTestInfo` (provider tag + one-line summary) on
/// success, or a flat `String` carrying the structured cloud error so the
/// UI can render it inline.
#[tauri::command]
pub async fn settings_test_provider(
    provider: String,
) -> Result<crate::cloud::ConnectionTestInfo, String> {
    let p = parse_provider(&provider)?;
    crate::cloud::test_connection(p)
        .await
        .map_err(|e| format!("{e}"))
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
                available: m.path_abs.is_file(),
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
            role: t.role.map(|r| match r {
                TrackRole::ARoll => "a-roll".to_string(),
                TrackRole::BRoll => "b-roll".to_string(),
                TrackRole::AudioA => "audio-a".to_string(),
                TrackRole::AudioB => "audio-b".to_string(),
            }),
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
                    params: layer_params_view(&l.params, &snap.media_pool),
                })
                .collect(),
        })
        .collect();

    let markers = snap
        .markers
        .iter()
        .map(|m| MarkerSummary {
            id: m.id.to_string(),
            t_us: m.t_us,
            end_t_us: m.end_t_us,
            label: m.label.clone(),
            color_hint: format!("#{:02x}{:02x}{:02x}", m.color.r, m.color.g, m.color.b),
        })
        .collect();

    let groups: Vec<GroupSummary> = snap
        .groups
        .iter()
        .map(|g| GroupSummary {
            id: g.id.to_string(),
            label: g.label.clone(),
            layer_ids: g.members.iter().map(|m| m.to_string()).collect(),
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
            lock_reason: history.lock_reason.clone(),
        },
        media,
        tracks,
        markers,
        groups,
    })
}

fn layer_params_view(
    params: &LayerParams,
    media_pool: &imbl::HashMap<state::MediaId, state::MediaItem>,
) -> LayerParamsView {
    use state::Animated;
    let static_or = |a: &Animated<f64>, fb: f64| -> f64 {
        match a {
            Animated::Static(v) => *v,
            Animated::Keyframed(kfs) => kfs.iter().next().map(|kf| kf.value).unwrap_or(fb),
        }
    };
    let static_or_rgba = |a: &Animated<Rgba>, fb: Rgba| -> Rgba {
        match a {
            Animated::Static(v) => *v,
            Animated::Keyframed(kfs) => kfs.iter().next().map(|kf| kf.value).unwrap_or(fb),
        }
    };
    let media_label_for = |id: &state::MediaId| -> String {
        media_pool
            .get(id)
            .and_then(|m| {
                m.label.clone().or_else(|| {
                    m.path_abs
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
            })
            .unwrap_or_else(|| id.to_string())
    };
    match params {
        LayerParams::VideoClip(p) => LayerParamsView::VideoClip(VideoClipView {
            media_id: p.media.to_string(),
            media_label: media_label_for(&p.media),
            src_in_us: p.src_in_us,
            src_out_us: p.src_out_us,
            x: static_or(&p.transform.x, 0.0),
            y: static_or(&p.transform.y, 0.0),
            scale_x: static_or(&p.transform.scale_x, 1.0),
            scale_y: static_or(&p.transform.scale_y, 1.0),
            opacity: static_or(&p.opacity, 1.0),
            speed: p.speed,
            flip_h: p.flip_h,
            flip_v: p.flip_v,
            fade_in_us: p.fade_in_us,
            fade_out_us: p.fade_out_us,
        }),
        LayerParams::ImageOverlay(p) => LayerParamsView::ImageOverlay(ImageOverlayView {
            media_id: p.media.to_string(),
            media_label: media_label_for(&p.media),
            x: static_or(&p.transform.x, 0.0),
            y: static_or(&p.transform.y, 0.0),
            scale_x: static_or(&p.transform.scale_x, 1.0),
            scale_y: static_or(&p.transform.scale_y, 1.0),
            opacity: static_or(&p.opacity, 1.0),
            fade_in_us: p.fade_in_us,
            fade_out_us: p.fade_out_us,
        }),
        LayerParams::Text(p) => LayerParamsView::Text(TextView {
            content: p.content.clone(),
            font_family: p.font.family.clone(),
            font_size_px: p.font.size_px,
            color: static_or_rgba(&p.color, Rgba::WHITE),
            x: static_or(&p.transform.x, 0.0),
            y: static_or(&p.transform.y, 0.0),
            opacity: static_or(&p.opacity, 1.0),
        }),
        LayerParams::Color(p) => LayerParamsView::Color(ColorView {
            color: static_or_rgba(&p.color, Rgba::BLACK),
            width: p.width,
            height: p.height,
        }),
        LayerParams::Audio(p) => LayerParamsView::Audio(AudioView {
            media_id: p.media.to_string(),
            media_label: media_label_for(&p.media),
            src_in_us: p.src_in_us,
            src_out_us: p.src_out_us,
            gain_db: static_or(&p.gain_db, 0.0),
            pan: static_or(&p.pan, 0.0),
            mute: p.mute,
        }),
        LayerParams::Subtitles(p) => {
            let (kind, value) = match &p.source {
                SubtitlesSource::Media(id) => ("Media".to_string(), id.to_string()),
                SubtitlesSource::InlineAss(s) => ("InlineAss".to_string(), s.clone()),
                SubtitlesSource::InlineSrt(s) => ("InlineSrt".to_string(), s.clone()),
            };
            LayerParamsView::Subtitles(SubtitlesView {
                source_kind: kind,
                source_value: value,
            })
        }
        LayerParams::Template(p) => LayerParamsView::Template {
            template_id: p.template_id.clone(),
        },
    }
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
                fade_in_us: 0,
                fade_out_us: 0,
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
                fade_in_us: 0,
                fade_out_us: 0,
            }),
            // Stills: default to 3 seconds of screen time.
            3_000_000,
        ),
        MediaKind::Subtitle => (
            LayerParams::Subtitles(SubtitlesParams {
                source: SubtitlesSource::Media(media),
            }),
            // Subtitle file's "duration" is its rendered span. Without parsing
            // the file we don't know it; default to 10s and let the user trim.
            10_000_000,
        ),
    };

    // Subtitles must live on a Subtitle track for the lowering to apply them.
    // Audio must live on an Audio track (the lowering only iterates audio
    // layers on Audio tracks). Image overlays land on the "Overlay" Video
    // track so they composite ABOVE base video — closing the UX paper-cut
    // (option 3) where a dropped image went on the same track as the base
    // video and got occluded by it. Mirrors the existing ensure_* pattern.
    let track = match media_item.kind {
        MediaKind::Subtitle => ensure_subtitle_track(handle.inner(), snap.as_ref()).await?,
        MediaKind::Audio => ensure_audio_track(handle.inner(), snap.as_ref()).await?,
        MediaKind::Image => ensure_overlay_track(handle.inner(), snap.as_ref()).await?,
        _ => track,
    };

    let t_end_us = t_start_us + span_us;

    let video_layer_id = handle
        .add_layer(Actor::User, track, params, t_start_us, t_end_us)
        .await
        .map_err(|e: CommandError| e.to_string())?;

    // `docs/group-system.md` — when the source is video-with-audio and
    // the project's `auto_pair_audio_on_import` setting is on, also place
    // an Audio layer pointing at the same MediaItem and group the pair.
    // Snapshot AFTER add_layer so the freshly-added video layer counts
    // toward overlap validation when we pick the audio track.
    if matches!(media_item.kind, MediaKind::Video)
        && media_item.metadata.audio.is_some()
        && snap.settings.auto_pair_audio_on_import
    {
        let post_video_snap = handle.snapshot().await;
        let audio_track = ensure_audio_track(handle.inner(), post_video_snap.as_ref()).await?;
        let audio_params = LayerParams::Audio(state::layer::AudioParams {
            media,
            src_in_us: 0,
            src_out_us: total_src,
            gain_db: Animated::Static(0.0),
            pan: Animated::Static(0.0),
            fade_in_us: 0,
            fade_out_us: 0,
            mute: false,
        });
        let audio_layer_id = handle
            .add_layer(
                Actor::User,
                audio_track,
                audio_params,
                t_start_us,
                t_end_us,
            )
            .await
            .map_err(|e: CommandError| e.to_string())?;
        handle
            .groups_create(
                Actor::User,
                vec![video_layer_id, audio_layer_id],
                None,
                false,
            )
            .await
            .map_err(|e: CommandError| e.to_string())?;
    }

    Ok(video_layer_id.to_string())
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
pub async fn add_text_layer(
    handle: State<'_, ProjectHandle>,
    track_id: String,
    content: String,
    t_start_us: TimeUs,
    duration_us: TimeUs,
) -> Result<String, String> {
    let track = Uuid::parse_str(&track_id).map_err(|e| format!("track_id: {e}"))?;
    let span = duration_us.max(100_000);
    let params = LayerParams::Text(state::layer::TextParams {
        content,
        font: state::layer::FontSpec {
            family: "Arial".to_string(),
            size_px: 72.0,
            weight: 400,
            italic: false,
        },
        color: Animated::Static(Rgba::WHITE),
        align: state::layer::TextAlign::Center,
        transform: Default::default(),
        opacity: Animated::Static(1.0),
        shadow: None,
        outline: None,
        intro: None,
        outro: None,
        backend_hint: state::layer::TextBackend::DrawText,
    });
    handle
        .add_layer(Actor::User, track, params, t_start_us, t_start_us + span)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn add_demo_text_layer(handle: State<'_, ProjectHandle>) -> Result<String, String> {
    // Append a 3s "TEXT" Text layer to the "Overlay" video track (auto-
    // created at the top of z-stack if it doesn't exist yet). Prior to the
    // UX paper-cut fix this landed on the first Video track, which is the
    // BOTTOM of z-stack — text rendered behind base video.
    let snap = handle.snapshot().await;
    let track_id = ensure_overlay_track(handle.inner(), snap.as_ref()).await?;
    let snap = handle.snapshot().await;
    let track = snap
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .expect("track just created");
    let t_start = track.layers.last().map(|l| l.t_end_us).unwrap_or(0);
    let t_end = t_start + 3_000_000;

    let params = LayerParams::Text(state::layer::TextParams {
        content: "TEXT".to_string(),
        font: state::layer::FontSpec {
            family: "Arial".to_string(),
            size_px: 96.0,
            weight: 700,
            italic: false,
        },
        color: Animated::Static(Rgba::WHITE),
        align: state::layer::TextAlign::Center,
        transform: Default::default(),
        opacity: Animated::Static(1.0),
        shadow: None,
        outline: None,
        intro: None,
        outro: None,
        backend_hint: state::layer::TextBackend::DrawText,
    });
    handle
        .add_layer(Actor::User, track_id, params, t_start, t_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn project_undo(handle: State<'_, ProjectHandle>) -> Result<(), String> {
    handle
        .undo(Actor::User)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// User-side checkpoint restore — wired to the agent-mode record
/// panel's Restore button. Rejects with the same HistoryLocked error
/// the MCP path raises when the agent holds the revert lock.
///
/// Emits a structured Restore LogEntry so the record panel can prune
/// the rolled-back agent actions from view (`details.kind === "Restore"`
/// carries the target `checkpoint_id` + `label`, and the entry's own
/// `ts` is the upper bound of the rolled-back window).
#[tauri::command]
pub async fn project_restore_checkpoint(
    app: tauri::AppHandle,
    handle: State<'_, ProjectHandle>,
    checkpoint_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&checkpoint_id)
        .map_err(|e| format!("checkpoint_id not a UUID: {e}"))?;
    // Look up the label BEFORE restoring — the actor's restore call
    // returns `()`, and we want the label for the Restore LogEntry's
    // `details` payload so the panel can show "Restored to '<label>'".
    let label = handle
        .list_checkpoints()
        .await
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.label);
    handle
        .restore_checkpoint(Actor::User, id)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    crate::logs::emit_via_app(
        &app,
        crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::Project,
            source: crate::logs::LogSource::User,
            message: match &label {
                Some(l) => format!("Restored to checkpoint: {l}"),
                None => format!("Restored to checkpoint: {id}"),
            },
            details: Some(serde_json::json!({
                "kind": "Restore",
                "checkpoint_id": id.to_string(),
                "label": label,
            })),
            ..Default::default()
        },
    );
    Ok(())
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
                    .split_layer(Actor::User, layer.id, mid, false)
                    .await
                    .map_err(|e: CommandError| e.to_string())?;
                return Ok(());
            }
        }
    }
    Err("no splittable layer (need at least 200ms)".to_string())
}

/// Force-flush autosave to disk for the current workspace. Safe to call
/// unconditionally — if no workspace is set yet (the unreachable blank-boot
/// window, in practice), `force_flush` is a no-op that just resolves.
#[tauri::command]
pub async fn project_save(
    autosave: State<'_, crate::io::autosave::AutosaveController>,
) -> Result<(), String> {
    autosave.force_flush().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn project_save_as(
    handle: State<'_, ProjectHandle>,
    cache: State<'_, crate::cache::CacheLayout>,
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
    recents: State<'_, crate::recents::RecentsStore>,
    log_slot: State<'_, crate::logs::LogBusSlot>,
    agent_session: State<'_, crate::agent_session::AgentSessionSlot>,
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let snap = handle.snapshot().await;
    let path = PathBuf::from(path);
    io::save_to_dir(&snap, &path)
        .await
        .map_err(|e| format!("{e:#}"))?;
    // Per workspace-redesign Q3, every save-as/open re-points the cache at
    // `<workspace>/Cache/`. From here on, proxies/thumbnails/waveforms/
    // preview renders land inside the workspace folder, not the OS app-cache.
    cache
        .set_workspace(&path)
        .map_err(|e| format!("cache set_workspace: {e:#}"))?;
    workspace.set(path.clone());
    // Workspace change resets any in-flight agent session — view mode
    // doesn't survive across project switches.
    let _ = crate::agent_session::end_and_emit(&app, &agent_session);
    // Install (or rotate) the LogBus for this workspace. Replaces any
    // prior bus; the old writer task drains + exits on mpsc-close.
    log_slot.install(crate::logs::LogBus::spawn(&path, app.clone()));
    recents.push(path, snap.metadata.name.clone());
    Ok(())
}

#[tauri::command]
pub async fn project_open(
    handle: State<'_, ProjectHandle>,
    cache: State<'_, crate::cache::CacheLayout>,
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
    recents: State<'_, crate::recents::RecentsStore>,
    log_slot: State<'_, crate::logs::LogBusSlot>,
    agent_session: State<'_, crate::agent_session::AgentSessionSlot>,
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    // Pre-check so we can produce a typed sentinel for the "user picked a
    // folder that isn't a WeftCut project" case. Without this the raw
    // anyhow chain bubbles up an OS-localized `read <path>/project.json:
    // <NLS-translated 'file not found' message> (os error 2)` which the
    // user can't make sense of. The frontend matches this sentinel and
    // renders a localized message; other errors flow through unchanged so
    // the detail is still visible for unexpected failures.
    if !path.join(io::PROJECT_FILE).exists() {
        return Err("NOT_PROJECT_FOLDER".to_string());
    }
    let project = io::load_from_dir(&path)
        .await
        .map_err(|e| format!("{e:#}"))?;
    // Re-point cache + workspace before broadcasting the state swap, so any
    // consumers that react to `project:changed` and immediately ask for
    // derivative paths or resolved media paths see the workspace, not the
    // boot fallback.
    cache
        .set_workspace(&path)
        .map_err(|e| format!("cache set_workspace: {e:#}"))?;
    workspace.set(path.clone());
    let _ = crate::agent_session::end_and_emit(&app, &agent_session);
    // Install (or rotate) the LogBus rooted at this workspace's Logs/.
    log_slot.install(crate::logs::LogBus::spawn(&path, app.clone()));
    let display_name = project.metadata.name.clone();
    handle
        .replace_state(Actor::User, project)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    recents.push(path, display_name);

    // `docs/preview-scrub.md` S.2 — fan out background jobs for any
    // media missing derivatives. `load_from_dir` cleared `proxy_path`
    // on entries whose `proxy_format_version` was below the current
    // encoder version; this catches those, plus any media whose
    // derivatives were deleted externally between sessions. The
    // proxy job's "skip-if-cached" check makes the call idempotent
    // for media whose proxies are already up-to-date.
    let snap = handle.snapshot().await;
    for item in snap.media_pool.values() {
        crate::jobs::enqueue_for_media(
            app.clone(),
            cache.inner().clone(),
            handle.inner().clone(),
            item.clone(),
        );
    }
    Ok(())
}

/// Create a brand-new workspace at `<parent_folder>/<name>/` with the given
/// composition preset, replace the actor's state with a fresh blank
/// project, and write it to disk. Used by the startup screen's "+ New
/// project" form. Per workspace-redesign Q7 this is the canonical way to
/// start a new project — the legacy "blank-on-boot then Save As later"
/// flow is going away in Phase B.3.
#[tauri::command]
pub async fn project_new_workspace(
    handle: State<'_, ProjectHandle>,
    cache: State<'_, crate::cache::CacheLayout>,
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
    recents: State<'_, crate::recents::RecentsStore>,
    log_slot: State<'_, crate::logs::LogBusSlot>,
    agent_session: State<'_, crate::agent_session::AgentSessionSlot>,
    app: tauri::AppHandle,
    parent_folder: String,
    name: String,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("project name is required".into());
    }
    if width == 0 || height == 0 || fps_num == 0 || fps_den == 0 {
        return Err("invalid canvas preset".into());
    }
    let parent_path = PathBuf::from(&parent_folder);
    let target = parent_path.join(trimmed);
    if target.exists() {
        // Either it's an old workspace we'd clobber, or just a folder the
        // user already picked. Refuse — startup screen flows route the
        // user to "Open" if the folder is a valid `.vproj`.
        return Err(format!(
            "folder already exists: {}",
            target.display()
        ));
    }

    let mut project = state::Project::new_blank(trimmed);
    project.composition.width = width;
    project.composition.height = height;
    project.composition.fps = Rational::new(fps_num, fps_den);

    io::save_to_dir(&project, &target)
        .await
        .map_err(|e| format!("save new workspace: {e:#}"))?;
    cache
        .set_workspace(&target)
        .map_err(|e| format!("cache set_workspace: {e:#}"))?;
    workspace.set(target.clone());
    let _ = crate::agent_session::end_and_emit(&app, &agent_session);
    log_slot.install(crate::logs::LogBus::spawn(&target, app.clone()));

    let display_name = project.metadata.name.clone();
    handle
        .replace_state(Actor::User, project)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    recents.push(target.clone(), display_name);
    // Remember the parent folder so the next "+ New project" form opens
    // pre-filled at the same location. Best-effort; failures are logged
    // inside the setter but don't surface here.
    recents.set_last_new_project_parent(parent_path);
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn recents_list(
    recents: State<'_, crate::recents::RecentsStore>,
) -> Result<Vec<crate::recents::RecentEntry>, String> {
    recents.list().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn recents_remove(
    recents: State<'_, crate::recents::RecentsStore>,
    path: String,
) -> Result<(), String> {
    recents
        .remove(&PathBuf::from(path))
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn recents_get_reopen_on_launch(
    recents: State<'_, crate::recents::RecentsStore>,
) -> Result<bool, String> {
    recents.reopen_on_launch().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn recents_set_reopen_on_launch(
    recents: State<'_, crate::recents::RecentsStore>,
    value: bool,
) -> Result<(), String> {
    recents
        .set_reopen_on_launch(value)
        .map_err(|e| format!("{e:#}"))
}

/// Returns the most recent workspace, if any. Used by the startup screen
/// on boot: when `reopen_on_launch` is enabled, the UI calls this and
/// immediately fires `project_open` on the result.
#[tauri::command]
pub async fn recents_most_recent(
    recents: State<'_, crate::recents::RecentsStore>,
) -> Result<Option<crate::recents::RecentEntry>, String> {
    recents.most_recent().map_err(|e| format!("{e:#}"))
}

/// Parent folder of the last project the user created via "+ New project".
/// `null` on first launch — the UI falls back to OS Documents.
#[tauri::command]
pub async fn recents_last_new_project_parent(
    recents: State<'_, crate::recents::RecentsStore>,
) -> Result<Option<String>, String> {
    recents
        .last_new_project_parent()
        .map(|opt| opt.map(|p| p.to_string_lossy().to_string()))
        .map_err(|e| format!("{e:#}"))
}

// --- Keyboard-shortcut overrides --------------------------------------
//
// The frontend `shortcuts/` module owns the action catalogue and the
// conflict-detection logic; these commands are a thin pass-through to
// `KeybindingsStore`. See `keybindings.rs` for the rationale.

#[tauri::command]
pub async fn keybindings_get(
    store: State<'_, crate::keybindings::KeybindingsStore>,
) -> Result<crate::keybindings::KeybindingsMap, String> {
    store.get().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn keybindings_set(
    store: State<'_, crate::keybindings::KeybindingsStore>,
    action: String,
    keys: Vec<String>,
) -> Result<(), String> {
    store.set(action, keys).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn keybindings_reset_all(
    store: State<'_, crate::keybindings::KeybindingsStore>,
) -> Result<(), String> {
    store.reset_all().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn keybindings_export(
    store: State<'_, crate::keybindings::KeybindingsStore>,
    dest: String,
) -> Result<(), String> {
    store
        .export_to(PathBuf::from(dest))
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn keybindings_import(
    store: State<'_, crate::keybindings::KeybindingsStore>,
    src: String,
) -> Result<crate::keybindings::KeybindingsMap, String> {
    store
        .import_from(&PathBuf::from(src))
        .map_err(|e| format!("{e:#}"))
}

// ---- Agent-session view-mode slot ----
//
// Pre-MCP (the agent-session begin/end is the agent-mode entry; that
// MCP tool is added in Phase 2), these commands surface the current
// slot to the UI and let the user exit on their own. The slot reset on
// workspace change is wired inline in `project_save_as` / `project_open`
// / `project_new_workspace` below.

#[tauri::command]
pub async fn agent_session_get(
    slot: State<'_, crate::agent_session::AgentSessionSlot>,
) -> Result<Option<crate::agent_session::AgentSession>, String> {
    Ok(slot.current())
}

/// Dev-only manual entry into agent mode. Lets us exercise the UI
/// without needing a connected MCP client to call begin_agent_session.
/// Mirrors the MCP tool's side-effects (auto-checkpoint, slot write,
/// agent_session:changed emission) but routes through Actor::User
/// since there's no agent actually attached.
///
/// Gated behind `cfg(debug_assertions)` so release builds never see
/// this command — the documented entry into agent mode is MCP-only.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn debug_simulate_agent_session(
    app: tauri::AppHandle,
    slot: State<'_, crate::agent_session::AgentSessionSlot>,
    handle: State<'_, ProjectHandle>,
    reason: String,
) -> Result<String, String> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("reason must be non-empty".into());
    }
    let label = format!("Pre-agent: {reason}");
    let checkpoint_id = handle
        .checkpoint(Actor::User, label.clone())
        .await;
    crate::logs::emit_via_app(
        &app,
        crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::Project,
            source: crate::logs::LogSource::Agent { client: "debug-sim".into() },
            message: format!("Checkpoint: {label}"),
            details: Some(serde_json::json!({
                "kind": "Checkpoint",
                "id": checkpoint_id.to_string(),
                "label": label,
            })),
            ..Default::default()
        },
    );
    let session = crate::agent_session::AgentSession {
        client: "debug-sim".into(),
        reason: reason.to_string(),
        started_at: Utc::now(),
    };
    crate::agent_session::begin_and_emit(&app, &slot, session);
    Ok(checkpoint_id.to_string())
}

/// Dev-only: take the revert lock so the badge + disabled-Restore
/// behavior can be exercised without a real agent.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn debug_lock_history(
    handle: State<'_, ProjectHandle>,
    reason: String,
) -> Result<(), String> {
    handle.lock_history(reason).await;
    Ok(())
}

/// Dev-only: release the revert lock.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn debug_unlock_history(
    handle: State<'_, ProjectHandle>,
) -> Result<(), String> {
    handle.unlock_history().await;
    Ok(())
}

/// User-side "Exit to editor" handler. Always allowed — even with a
/// lock or in-flight ops (Q3/Q4 invariants). Releases the revert lock
/// so the user can immediately undo/restore once back in editor mode.
#[tauri::command]
pub async fn agent_session_end(
    app: tauri::AppHandle,
    slot: State<'_, crate::agent_session::AgentSessionSlot>,
    handle: State<'_, ProjectHandle>,
) -> Result<(), String> {
    let prior = crate::agent_session::end_and_emit(&app, &slot);
    // Release any agent-taken revert lock so the human's editor-mode
    // Undo / Restore buttons re-enable on the next paint.
    handle.unlock_history().await;
    if let Some(s) = prior {
        // System-attributed entry so the record panel — already
        // closed by the time this lands — and the full LogConsole
        // both surface the transition.
        crate::logs::emit_via_app(
            &app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::System,
                source: crate::logs::LogSource::System,
                message: format!(
                    "User exited agent mode (session client={} reason={})",
                    s.client, s.reason,
                ),
                ..Default::default()
            },
        );
    }
    Ok(())
}

// ---- Per-workspace view state (timeline zoom + per-track heights) ----
//
// Lives at `<workspace>/view.json`. The frontend reads on mount and
// writes debounced (200 ms after the last edit) — that's why both
// commands are whole-file: there's no per-field churn worth optimising.
//
// Pre-workspace (blank-on-boot session before any save / open) the
// commands return defaults / silently no-op so the UI stays usable.

#[tauri::command]
pub async fn view_state_get(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
) -> Result<crate::view_state::ViewState, String> {
    let Some(ws) = workspace.current() else {
        return Ok(crate::view_state::ViewState::default());
    };
    Ok(crate::view_state::load(&ws))
}

#[tauri::command]
pub async fn view_state_set(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
    state: crate::view_state::ViewState,
) -> Result<(), String> {
    let Some(ws) = workspace.current() else {
        // Pre-workspace: silently drop. Once the user does a Save As,
        // the next debounced write will land in the new workspace.
        return Ok(());
    };
    crate::view_state::save(&ws, &state).map_err(|e| format!("{e:#}"))
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
    app: tauri::AppHandle,
    handle: State<'_, ProjectHandle>,
    cache: State<'_, crate::cache::CacheLayout>,
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
    import_queue: State<'_, crate::jobs::import::ImportQueue>,
    path: String,
) -> Result<String, String> {
    let source_buf = PathBuf::from(&path);
    let item = tokio::task::spawn_blocking({
        let source_buf = source_buf.clone();
        move || -> Result<MediaItem, String> {
            let facts = io::probe::hash_and_stat(&source_buf).map_err(|e| format!("{e:#}"))?;
            let metadata = io::probe::probe_metadata(&source_buf);
            let kind: MediaKind = io::probe::detect_kind(&source_buf, &metadata);
            let label = source_buf
                .file_name()
                .map(|n| n.to_string_lossy().to_string());
            Ok(MediaItem {
                id: new_id(),
                label,
                // path_abs starts as the source location. The background
                // import worker (jobs::import) flips it to the workspace
                // copy once it lands, via SetMediaWorkspacePaths.
                path_abs: source_buf,
                path_rel: None,
                kind,
                metadata,
                proxy_path: None,

                proxy_format_version: 0,
                waveform_path: None,
                thumbnails_dir: None,
                file_hash_blake3: facts.blake3_hex,
                file_size: facts.size,
                file_mtime: facts.mtime_secs,
                imported_at: Utc::now(),
            })
        }
    })
    .await
    .map_err(|e| format!("import join: {e}"))??;

    let item_for_jobs = item.clone();
    let media_id = item.id;
    let id = handle
        .add_media_item(Actor::User, item)
        .await
        .map_err(|e: CommandError| e.to_string())?;

    // Derivatives (proxy / thumbnails / waveform) are content-addressed by
    // blake3 hash, so the cache key doesn't care whether the worker reads
    // from the original or the post-copy workspace location. Kick them
    // immediately from the original path; they'll race the copy and the
    // results are valid either way.
    crate::jobs::enqueue_for_media(
        app,
        (*cache).clone(),
        (*handle).clone(),
        item_for_jobs,
    );

    // Per workspace-redesign Q6 + Q2 we copy the source into
    // `<workspace>/Media/`. The copy is a background FIFO job; the actor
    // gets a SetMediaWorkspacePaths callback once the copy lands. Without
    // a workspace yet (transitional boot state — Phase B's startup screen
    // makes this unreachable), skip the copy and leave the MediaItem
    // pointing at the original. The next save-as / open will set the
    // workspace and any future imports get copied normally.
    if let Some(ws) = workspace.current() {
        import_queue.enqueue(
            (*handle).clone(),
            media_id,
            source_buf,
            ws,
        );
    } else {
        tracing::warn!(
            "import_media: no workspace set; MediaItem stays referencing the original \
             source. Open or save the project to a workspace folder to copy it in."
        );
    }

    Ok(id.to_string())
}

/// Return the current preview MP4 path (if a Phase-D render has landed)
/// so the React `<PreviewSurface>` can pick the right `<video src>` on
/// mount without waiting for the next commit-debounce-render cycle.
#[tauri::command]
pub async fn preview_current_path(
    renderer: State<'_, crate::preview::PreviewRenderer>,
) -> Result<Option<String>, String> {
    Ok(renderer
        .current_path()
        .map(|p| p.to_string_lossy().to_string()))
}

/// Update the segmented-preview renderer's playhead position so the next
/// queue push assigns `PriorityClass::Playhead` to the segment containing
/// `t_us`. No-op when the segmented renderer isn't running (i.e., the
/// `WEFTCUT_PREVIEW_SEGMENTED` env var wasn't set at startup).
#[tauri::command]
pub async fn preview_set_playhead(
    app: tauri::AppHandle,
    t_us: i64,
) -> Result<(), String> {
    use tauri::Manager;
    if let Some(renderer) =
        app.try_state::<crate::preview::segmented::SegmentedRenderer>()
    {
        renderer.set_playhead(t_us);
    }
    Ok(())
}

/// User-triggered manual retry of a failed segment. Returns true if the
/// segment was found in the current manifest and queued. The Rust side
/// has all the typed state — React just passes the hash string.
#[tauri::command]
pub async fn preview_retry_segment(
    app: tauri::AppHandle,
    hash: String,
) -> Result<bool, String> {
    use tauri::Manager;
    let Some(renderer) =
        app.try_state::<crate::preview::segmented::SegmentedRenderer>()
    else {
        return Ok(false);
    };
    Ok(renderer.retry_segment(&hash).await)
}

#[tauri::command]
pub async fn import_cancel(
    import_queue: State<'_, crate::jobs::import::ImportQueue>,
    media_id: String,
) -> Result<bool, String> {
    let id = Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    Ok(import_queue.cancel(id))
}

#[tauri::command]
pub async fn import_queue_list(
    import_queue: State<'_, crate::jobs::import::ImportQueue>,
) -> Result<Vec<crate::jobs::import::ImportEntry>, String> {
    Ok(import_queue.list())
}

#[tauri::command]
pub async fn compile_project(
    app: tauri::AppHandle,
    handle: State<'_, ProjectHandle>,
    cache: State<'_, crate::cache::CacheLayout>,
) -> Result<CompiledGraph, String> {
    let snap = handle.snapshot().await;
    let target = ir::RenderTarget::full(
        snap.composition.width,
        snap.composition.height,
        Rational::new(snap.composition.fps.num, snap.composition.fps.den),
        snap.composition.sample_rate,
        snap.composition.channels,
    );
    let inline_subs =
        ir::materialize_inline_subtitles(&snap, &cache).map_err(|e| e.to_string())?;
    let template_renders = ir::materialize_templates(&snap, &cache, &app)
        .await
        .map_err(|e| e.to_string())?;
    let graph = ir::lower(&snap, target, &inline_subs, &template_renders)
        .map_err(|e| e.to_string())?;
    let plan = ir::emit_ffmpeg(&graph);
    Ok(CompiledGraph {
        // CompiledGraph is shown in a debug panel — just the paths, no
        // framerate flags. Callers that build a real ffmpeg command line
        // (export/mod.rs) should use `PlanInput::cli_args` directly.
        inputs: plan.inputs.iter().map(|i| i.path.clone()).collect(),
        filter_graph: plan.filter_graph,
        maps: plan.maps,
        node_count: graph.nodes.len(),
    })
}

/// Phase B3: emit the WebCodecs composition recipe for the current
/// project snapshot. Mirrors `compile_project`'s path (materialize
/// templates + inline subtitles, snapshot the project) but produces
/// the JSON recipe consumed by the WebGL2 compositor instead of the
/// ffmpeg filter graph. Pure read; no mutation.
#[tauri::command]
pub async fn preview_webcodecs_recipe(
    app: tauri::AppHandle,
    handle: State<'_, ProjectHandle>,
    cache: State<'_, crate::cache::CacheLayout>,
) -> Result<ir::WebcodecsRecipe, String> {
    let snap = handle.snapshot().await;
    // `docs/preview-scrub.md` S.3 — recipe runs on the 540p proxy
    // (when available) to give the WebCodecs decoder dense keyframes
    // for fast `mp4box.seek`. `with_proxies_substituted` gracefully
    // falls back to `media.path_abs` for items whose proxy hasn't
    // been generated yet; segmented preview uses the same path.
    let project_for_recipe = crate::preview::with_proxies_substituted(&snap);
    let target = ir::RenderTarget::full(
        project_for_recipe.composition.width,
        project_for_recipe.composition.height,
        Rational::new(
            project_for_recipe.composition.fps.num,
            project_for_recipe.composition.fps.den,
        ),
        project_for_recipe.composition.sample_rate,
        project_for_recipe.composition.channels,
    );
    let template_renders = ir::materialize_templates(&project_for_recipe, &cache, &app)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ir::emit_webcodecs(
        &project_for_recipe,
        &target,
        &template_renders,
    ))
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
pub async fn update_layer_params(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
    patch: LayerParamsPatch,
) -> Result<(), String> {
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .update_layer_params(Actor::User, id, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Add a subtitles layer that burns a subtitle file (`.srt` / `.ass`) onto
/// the timeline. The path must be absolute and point to an on-disk file —
/// import the file via `import_media` first if it isn't already in the pool.
#[tauri::command]
pub async fn add_subtitles_layer(
    handle: State<'_, ProjectHandle>,
    media_id: String,
    t_start_us: TimeUs,
    duration_us: TimeUs,
) -> Result<String, String> {
    let media = Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let media_item = snap
        .media_pool
        .get(&media)
        .ok_or_else(|| "media not found in pool".to_string())?;
    if !matches!(media_item.kind, MediaKind::Subtitle) {
        return Err(format!(
            "media {media_id} is {:?}, expected Subtitle",
            media_item.kind
        ));
    }
    let track_id = ensure_subtitle_track(handle.inner(), snap.as_ref()).await?;
    let span = duration_us.max(100_000);
    let params = LayerParams::Subtitles(SubtitlesParams {
        source: SubtitlesSource::Media(media),
    });
    handle
        .add_layer(Actor::User, track_id, params, t_start_us, t_start_us + span)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

async fn ensure_subtitle_track(
    handle: &ProjectHandle,
    snap: &state::Project,
) -> Result<state::TrackId, String> {
    if let Some(t) = snap
        .tracks
        .iter()
        .find(|t| matches!(t.kind, TrackKind::Subtitle))
    {
        return Ok(t.id);
    }
    handle
        .add_track(Actor::User, TrackKind::Subtitle, Some("Subtitles".into()))
        .await
        .map_err(|e: CommandError| e.to_string())
}

async fn ensure_audio_track(
    handle: &ProjectHandle,
    snap: &state::Project,
) -> Result<state::TrackId, String> {
    if let Some(t) = snap
        .tracks
        .iter()
        .find(|t| matches!(t.kind, TrackKind::Audio))
    {
        return Ok(t.id);
    }
    handle
        .add_track(Actor::User, TrackKind::Audio, Some("Audio".into()))
        .await
        .map_err(|e: CommandError| e.to_string())
}

async fn ensure_template_target_track(
    handle: &ProjectHandle,
    snap: &state::Project,
) -> Result<state::TrackId, String> {
    // Templates are overlays — share the same "Overlay" track as image
    // overlays and the demo text layer so the user doesn't accumulate one
    // dedicated track per content type. Same z-stack rationale as
    // `ensure_overlay_track`.
    ensure_overlay_track(handle, snap).await
}

/// Find a Video track labeled "Overlay" or auto-create one at the top of
/// z-stack. Image / Text overlays land here by default so they composite
/// ABOVE base video tracks (A roll / B roll) instead of being occluded by
/// them — the UX paper-cut closed 2026-05-12 (option 3 in
/// `project_phase_status.md`).
///
/// The label match is exact: if the user renamed the Overlay track,
/// subsequent drops create a new "Overlay" track rather than reusing the
/// renamed one. That's deliberate — the rename is treated as opting out
/// of the convention.
async fn ensure_overlay_track(
    handle: &ProjectHandle,
    snap: &state::Project,
) -> Result<state::TrackId, String> {
    if let Some(t) = snap.tracks.iter().find(|t| {
        matches!(t.kind, TrackKind::Video) && t.label.as_deref() == Some("Overlay")
    }) {
        return Ok(t.id);
    }
    handle
        .add_track(Actor::User, TrackKind::Video, Some("Overlay".into()))
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Stage F-Picker: the UI catalog. A superset of the MCP `list_templates`
/// payload — every manifest field plus the raw `html` / `style` strings so
/// the picker can render live iframe previews client-side. The MCP surface
/// stays manifest-only (see `mcp::templates_payload`); the extra fields are
/// UI-only and would just bloat agent context.
#[tauri::command]
pub async fn list_templates() -> Result<Vec<serde_json::Value>, String> {
    raster_template::builtins()
        .into_iter()
        .map(|tpl| {
            let mut v = serde_json::to_value(&tpl.manifest)
                .map_err(|e| format!("manifest serialize: {e}"))?;
            let obj = v
                .as_object_mut()
                .ok_or_else(|| "manifest is not a JSON object".to_string())?;
            obj.insert("html".to_string(), serde_json::Value::String(tpl.html));
            obj.insert("style".to_string(), serde_json::Value::String(tpl.style));
            Ok(v)
        })
        .collect()
}

/// Render a static thumbnail of the named template at default props and a
/// representative time, returning the PNG bytes base64-encoded so React
/// can wrap them in a `data:image/png;base64,…` URL. Goes through the
/// same offscreen-webview raster pipeline IR Template layers use, so the
/// thumbnail is pixel-accurate to what ffmpeg would emit. First call per
/// template is ~200–700ms on a cold cache; subsequent calls are
/// near-instant via the content-keyed raster cache.
#[tauri::command]
pub async fn template_preview(
    app: tauri::AppHandle,
    cache: State<'_, crate::cache::CacheLayout>,
    template_id: String,
) -> Result<String, String> {
    let template = raster_template::builtins()
        .into_iter()
        .find(|t| t.id() == template_id)
        .ok_or_else(|| {
            format!(
                "unknown template_id '{template_id}' — call list_templates for the catalog",
            )
        })?;
    // Default props match what the picker's card thumbnails currently feed
    // their iframes, so the static-render swap is visually equivalent.
    let canonical = template
        .canonicalize_props(&serde_json::Value::Object(Default::default()))
        .map_err(|e| format!("canonicalize defaults: {e}"))?;
    // 0.5 * default_duration_s clamped at [0, 1] — same heuristic as the
    // MCP `templates://<id>/preview` resource (kept in sync deliberately
    // so card thumbnails and the agent-facing surface render identically).
    let t = template.manifest.default_duration_s * 0.5;
    let t = t.clamp(0.0, 1.0);
    let job = crate::raster::RasterJob {
        template,
        props_canonical_json: canonical,
        fps: 1,
        times_s: vec![t],
    };
    let out = crate::raster::render(&app, cache.inner(), job).await?;
    let frame = out
        .frames
        .first()
        .ok_or_else(|| "render returned zero frames".to_string())?;
    let bytes = tokio::fs::read(&frame.path)
        .await
        .map_err(|e| format!("read {}: {e}", frame.path.display()))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Stage F-Picker: UI counterpart to the MCP `add_template` tool. Mirrors
/// the behavior 1:1 (canonicalize props through the Template module,
/// default `t_end_us` from manifest duration, default the track to the
/// first Video track or auto-create "Templates"), only the actor identity
/// differs — `Actor::User` here vs. `Actor::Agent { client: "mcp" }`
/// there.
#[tauri::command]
pub async fn add_template(
    handle: State<'_, ProjectHandle>,
    template_id: String,
    t_start_us: TimeUs,
    t_end_us: Option<TimeUs>,
    track_id: Option<String>,
    props: Option<serde_json::Value>,
) -> Result<String, String> {
    let template = raster_template::builtins()
        .into_iter()
        .find(|t| t.id() == template_id)
        .ok_or_else(|| {
            format!(
                "unknown template_id '{template_id}' — call list_templates for the catalog",
            )
        })?;

    let provided = props.unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    let canonical = template
        .canonicalize_props(&provided)
        .map_err(|e| format!("invalid props: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&canonical).map_err(|e| format!("canonical props parse: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "canonical props is not a JSON object".to_string())?;
    let props_map: imbl::HashMap<String, serde_json::Value> =
        obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

    let resolved_end = match t_end_us {
        Some(end) => end,
        None => {
            let duration_us =
                (template.manifest.default_duration_s * 1_000_000.0) as i64;
            t_start_us.saturating_add(duration_us)
        }
    };
    if resolved_end <= t_start_us {
        return Err(format!(
            "t_end_us {resolved_end} must be greater than t_start_us {t_start_us}",
        ));
    }

    let track = match track_id {
        Some(s) => Uuid::parse_str(&s).map_err(|e| format!("track_id: {e}"))?,
        None => {
            let snap = handle.snapshot().await;
            ensure_template_target_track(handle.inner(), snap.as_ref()).await?
        }
    };

    let params = LayerParams::Template(TemplateParams {
        template_id: template.id().to_string(),
        template_version: template.manifest.version,
        props: props_map,
        transform: Transform::default(),
        opacity: Animated::Static(1.0),
    });

    handle
        .add_layer(Actor::User, track, params, t_start_us, resolved_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn move_layer(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
    new_track_id: String,
    new_t_start_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(), String> {
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let tid = Uuid::parse_str(&new_track_id).map_err(|e| format!("new_track_id: {e}"))?;
    handle
        .move_layer(
            Actor::User,
            lid,
            tid,
            new_t_start_us,
            escape_group.unwrap_or(false),
        )
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// `docs/group-system.md` — group-aware trim. `edge` is `"in"` or `"out"`.
/// When the layer is in a group and `escape_group` is false (default),
/// aligned-edge coupling fans the trim out to other members.
#[tauri::command]
pub async fn trim_layer(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
    edge: String,
    new_t_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(), String> {
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let parsed_edge = match edge.to_ascii_lowercase().as_str() {
        "in" | "start" => crate::state::actor::LayerEdge::In,
        "out" | "end" => crate::state::actor::LayerEdge::Out,
        other => return Err(format!("unknown edge '{other}' (expected 'in' or 'out')")),
    };
    handle
        .trim_layer(
            Actor::User,
            lid,
            parsed_edge,
            new_t_us,
            escape_group.unwrap_or(false),
        )
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn split_layer_grouped(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
    at_t_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(String, String), String> {
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let (left, right) = handle
        .split_layer(Actor::User, lid, at_t_us, escape_group.unwrap_or(false))
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok((left.to_string(), right.to_string()))
}

#[tauri::command]
pub async fn groups_create(
    handle: State<'_, ProjectHandle>,
    layer_ids: Vec<String>,
    label: Option<String>,
    reassign: Option<bool>,
) -> Result<String, String> {
    let ids: Vec<state::LayerId> = layer_ids
        .into_iter()
        .map(|s| Uuid::parse_str(&s).map_err(|e| format!("layer_id: {e}")))
        .collect::<Result<_, _>>()?;
    let gid = handle
        .groups_create(Actor::User, ids, label, reassign.unwrap_or(false))
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok(gid.to_string())
}

#[tauri::command]
pub async fn groups_dissolve(
    handle: State<'_, ProjectHandle>,
    group_id: String,
) -> Result<(), String> {
    let gid = Uuid::parse_str(&group_id).map_err(|e| format!("group_id: {e}"))?;
    handle
        .groups_dissolve(Actor::User, gid)
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

/// Open a libmpv popup window and play the given raw file. Uses the popup
/// slot (no host HWND registered) so it lands in a standalone top-level
/// window — separate from the embedded project preview. Closed by the user
/// via the OS close button; the drain-events poller cleans up the handle.
#[tauri::command]
pub async fn mpv_play_file(
    popup: tauri::State<'_, mpv::MpvPopupSlot>,
    path: String,
) -> Result<(), String> {
    let slot = popup.inner().0.clone();
    tokio::task::spawn_blocking(move || mpv::play_file(&slot, &path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// Resolve a `MediaId` to its absolute path and open it in a popup preview
/// window. Uses the popup slot — a standalone OS window with no z-order
/// conflict against the Phase-D DOM `<video>` preview, so libmpv survives
/// for this one isolated path while the embedded project preview is
/// gone.
#[tauri::command]
pub async fn mpv_play_media(
    handle: State<'_, ProjectHandle>,
    popup: tauri::State<'_, mpv::MpvPopupSlot>,
    media_id: String,
) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let item = snap
        .media_pool
        .get(&id)
        .ok_or_else(|| "media not found in pool".to_string())?;
    let path = item.path_abs.to_string_lossy().to_string();
    let slot = popup.inner().0.clone();
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
    preset: Option<export::ExportPreset>,
) -> Result<(), String> {
    let snap = handle.snapshot().await;
    let path = PathBuf::from(output_path);
    let project = (*snap).clone();
    let preset = preset.unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        export::export_with_preset_logged(app, &project, path, preset).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn export_queue_enqueue(
    queue: State<'_, export::ExportQueue>,
    handle: State<'_, ProjectHandle>,
    output_path: String,
    preset: Option<export::ExportPreset>,
) -> Result<String, String> {
    let snap = handle.snapshot().await;
    let preset = preset.unwrap_or_default();
    let id = queue
        .enqueue(snap, output_path, preset)
        .await;
    Ok(id.to_string())
}

#[tauri::command]
pub async fn export_queue_list(
    queue: State<'_, export::ExportQueue>,
) -> Result<Vec<export::ExportQueueItem>, String> {
    Ok(queue.list().await)
}

#[tauri::command]
pub async fn export_queue_remove(
    queue: State<'_, export::ExportQueue>,
    id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|e| format!("id: {e}"))?;
    queue.remove(id).await
}

#[tauri::command]
pub async fn export_queue_clear_finished(
    queue: State<'_, export::ExportQueue>,
) -> Result<(), String> {
    queue.clear_finished().await;
    Ok(())
}

#[tauri::command]
pub async fn hw_encoder_probe(
    cache: State<'_, export::HwEncoderCache>,
) -> Result<export::HwEncoderProbe, String> {
    Ok((*cache.probe().await).clone())
}

#[tauri::command]
pub async fn project_redo(handle: State<'_, ProjectHandle>) -> Result<(), String> {
    handle
        .redo(Actor::User)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct WaveformPeaks {
    pub peaks: Vec<f32>,
    pub peaks_per_second: u32,
}

/// Returns a `data:image/jpeg;base64,...` URL for the middle frame of the
/// cached thumbnail set, suitable for an `<img src>`. Errors with `not_ready`
/// if the thumbnails job hasn't finished — frontend should retry on
/// `media:job_complete kind=thumbnails`.
#[tauri::command]
pub async fn get_media_thumbnail(
    handle: State<'_, ProjectHandle>,
    media_id: String,
) -> Result<String, String> {
    use base64::Engine;
    let media_uuid = Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let media = snap
        .media_pool
        .get(&media_uuid)
        .ok_or_else(|| format!("media {media_id} not found"))?;
    let dir = media
        .thumbnails_dir
        .clone()
        .ok_or_else(|| "not_ready".to_string())?;
    // 10 thumbnails, indices 000..009 — pick the middle one as representative.
    let path = dir.join("004.jpg");
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

/// Read the cached peaks file for `media_id` and return the f32 array plus the
/// peaks-per-second rate the timeline needs to map a layer's src window onto
/// a slice of the peaks. Errors with `not_ready` if the waveform job hasn't
/// finished yet — frontend should listen for `media:job_complete kind=waveform`
/// and retry.
#[tauri::command]
pub async fn get_waveform_peaks(
    handle: State<'_, ProjectHandle>,
    media_id: String,
) -> Result<WaveformPeaks, String> {
    let media_uuid = Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let media = snap
        .media_pool
        .get(&media_uuid)
        .ok_or_else(|| format!("media {media_id} not found"))?;
    let path = media
        .waveform_path
        .clone()
        .ok_or_else(|| "not_ready".to_string())?;
    let peaks = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_peaks_file(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read peaks: {e:#}"))?;
    Ok(WaveformPeaks {
        peaks,
        peaks_per_second: crate::jobs::waveform::PEAKS_PER_SECOND,
    })
}

// ============================================================
// Status / log surface (see `docs/status-log-system.md`).
//
// `log_list` snapshots the in-memory ring for the frontend Zustand
// store on mount. `log_clear` empties the ring (the JSONL file is
// untouched). `log_emit` is the frontend-originated entry path —
// shortcut results, UI-side errors. Pre-workspace these are silent
// no-ops; the slot is `None` until a workspace is opened.
// ============================================================

#[tauri::command]
pub async fn log_list(
    slot: State<'_, crate::logs::LogBusSlot>,
) -> Result<Vec<crate::logs::LogEntry>, String> {
    Ok(slot.current().map(|b| b.list()).unwrap_or_default())
}

#[tauri::command]
pub async fn log_clear(slot: State<'_, crate::logs::LogBusSlot>) -> Result<(), String> {
    if let Some(bus) = slot.current() {
        bus.clear();
    }
    Ok(())
}

#[tauri::command]
pub async fn log_emit(
    slot: State<'_, crate::logs::LogBusSlot>,
    input: crate::logs::LogEntryInput,
) -> Result<(), String> {
    slot.emit(input);
    Ok(())
}

/// Absolute path to the current workspace's `Logs/` directory, or
/// `None` pre-workspace. The frontend's "Open log folder" action
/// passes this string to `shell.open(...)` so the OS file manager
/// reveals it.
#[tauri::command]
pub async fn log_dir_path(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
) -> Result<Option<String>, String> {
    Ok(workspace
        .current()
        .map(|p| p.join("Logs").to_string_lossy().to_string()))
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

