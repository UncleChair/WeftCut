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
use crate::motifs::catalog;
use crate::state::{
    self, Actor, ColorParams, CommandError, LayerParams, MediaItem, MediaKind, ProjectHandle,
    MotifParams, Rgba, SubtitlesParams, SubtitlesSource, Transform,
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
    /// V.5 (A/B-roll v2): tracks are kind-agnostic. This field used to
    /// expose `TrackKind` (Video / Audio / Subtitle). It's preserved
    /// for transitional UI compatibility and now reports the dominant
    /// layer-class on the track — `"Video"` when the track has any
    /// visual-class layer, `"Audio"` when it's audio-only, `"Empty"`
    /// when it has no layers at all. V.10 frontend cleanup removes
    /// the field entirely from the wire.
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
    /// True when this track was spawned by R.3's "fresh hidden track per
    /// import" path and is therefore subject to auto-prune. The UI can
    /// use this to render the track-header chrome differently (it's
    /// going to disappear the moment its layer is dragged off).
    pub transient: bool,
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
    Motif(MotifView),
}

#[derive(Serialize, Clone)]
pub struct MotifView {
    pub motif_id: String,
    /// Canvas-space pixel offset.
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub opacity: f64,
    pub src_in_us: i64,
    /// Validated props the user set on this motif instance.
    /// Keys match the motif manifest's `props_schema`; values
    /// are whatever JSON shape that schema permits (string / number /
    /// color-as-string). The DOM preview injects this verbatim as
    /// `__props__` on the per-instance shadowed window-proxy inside
    /// the motif host (`<div>` + Shadow DOM; see
    /// `MotifHandle.ts`).
    pub props: serde_json::Map<String, serde_json::Value>,
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
    /// Absolute path of the proxy MP4 produced by `jobs/proxy.rs`, when
    /// one exists. `None` until the background job completes (or for
    /// media kinds that don't get proxied — e.g. audio-only sources).
    /// DOM preview falls back to `path` when this is `None`.
    pub proxy_path: Option<String>,
    /// Fast preview-only proxy. Export intentionally ignores this path.
    pub quick_proxy_path: Option<String>,
    /// True when the workspace copy is safe for direct WebCodecs use and no
    /// generated proxy is required.
    pub proxy_bypassed: bool,
    /// True when export may decode the original directly (preview still uses
    /// a generated proxy). See `MediaItem::export_uses_original`.
    pub export_uses_original: bool,
    /// Source video codec (e.g. "h264", "hevc", "prores"), `None` for
    /// audio/image. Raw passthrough from `metadata.video` — display-only.
    pub codec: Option<String>,
    /// Source pixel format (e.g. "yuv420p", "yuv420p10le"), `None` for
    /// audio/image. Raw passthrough — display-only.
    pub pix_fmt: Option<String>,
    /// Source color matrix (e.g. "bt709", "bt601"), `None` when unknown.
    pub color_matrix: Option<String>,
    /// Source color range ("tv" / "pc"), `None` when unknown.
    pub color_range: Option<String>,
    /// Source color primaries (e.g. "bt709"), `None` when unknown.
    pub color_primaries: Option<String>,
    /// Source color transfer characteristics (e.g. "bt709"), `None` when unknown.
    pub color_transfer: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct CompositionSummary {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// Mirrors `Composition.duration_pinned`. UI uses it to render the
    /// "Pin composition duration" toggle state in the menu.
    pub duration_pinned: bool,
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
            let proxy_path = m
                .proxy_path
                .as_ref()
                .and_then(|p| p.is_file().then(|| p.to_string_lossy().to_string()));
            let quick_proxy_path = m
                .quick_proxy_path
                .as_ref()
                .and_then(|p| p.is_file().then(|| p.to_string_lossy().to_string()));
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
                proxy_path,
                quick_proxy_path,
                proxy_bypassed: m.proxy_bypassed,
                export_uses_original: m.export_uses_original,
                codec: m.metadata.video.as_ref().map(|v| v.codec.clone()),
                pix_fmt: m.metadata.video.as_ref().map(|v| v.pix_fmt.clone()),
                color_matrix: m.metadata.video.as_ref().and_then(|v| v.color_matrix.clone()),
                color_range: m.metadata.video.as_ref().and_then(|v| v.color_range.clone()),
                color_primaries: m.metadata.video.as_ref().and_then(|v| v.color_primaries.clone()),
                color_transfer: m.metadata.video.as_ref().and_then(|v| v.color_transfer.clone()),
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
            // V.5: derive `kind` from the track's layers. Visual-class
            // layers win; audio-only tracks report "Audio"; empty
            // tracks report "Video" so the existing UI still styles
            // the reserved A/B-roll rows as video lanes by default.
            kind: derive_track_kind_label(t),
            label: t.label.clone(),
            enabled: t.enabled,
            locked: t.locked,
            role: t.role.map(|r| match r {
                TrackRole::ARoll => "a-roll".to_string(),
                TrackRole::BRoll => "b-roll".to_string(),
                TrackRole::AudioA => "audio-a".to_string(),
                TrackRole::AudioB => "audio-b".to_string(),
            }),
            transient: t.transient,
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
            duration_pinned: snap.composition.duration_pinned,
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
        LayerParams::Motif(p) => {
            // imbl::HashMap<String, Value> → serde_json::Map. The values
            // are already serde_json::Value; we just need to materialize
            // the map into a serializable shape.
            let mut props = serde_json::Map::new();
            for (k, v) in p.props.iter() {
                props.insert(k.clone(), v.clone());
            }
            LayerParamsView::Motif(MotifView {
                motif_id: p.motif_id.clone(),
                x: static_or(&p.transform.x, 0.0),
                y: static_or(&p.transform.y, 0.0),
                scale_x: static_or(&p.transform.scale_x, 1.0),
                scale_y: static_or(&p.transform.scale_y, 1.0),
                opacity: static_or(&p.opacity, 1.0),
                src_in_us: p.src_in_us,
                props,
            })
        }
    }
}

fn layer_kind(params: &LayerParams) -> String {
    match params {
        LayerParams::VideoClip(_) => "VideoClip",
        LayerParams::ImageOverlay(_) => "ImageOverlay",
        LayerParams::Text(_) => "Text",
        LayerParams::Motif(_) => "Motif",
        LayerParams::Audio(_) => "Audio",
        LayerParams::Subtitles(_) => "Subtitles",
        LayerParams::Color(_) => "Color",
    }
    .to_string()
}

/// V.5 transitional helper. Derives a `TrackKind`-like label from the
/// track's layers so the existing UI can keep its kind-based styling
/// (`.kind-video`, `.kind-audio`) until V.10 cleans the frontend up.
///
/// Rules:
///   - any visual-class layer present → "Video"
///   - audio-only → "Audio"
///   - empty → "Video" (so reserved A/B-roll rows on a blank project
///     still style as video lanes — keeps the timeline visual stable)
fn derive_track_kind_label(track: &crate::state::Track) -> String {
    let mut has_visual = false;
    let mut has_audio = false;
    for layer in track.layers.iter() {
        match &layer.params {
            LayerParams::Audio(_) => has_audio = true,
            LayerParams::VideoClip(_)
            | LayerParams::ImageOverlay(_)
            | LayerParams::Color(_)
            | LayerParams::Motif(_)
            | LayerParams::Text(_) => has_visual = true,
            LayerParams::Subtitles(_) => {
                // Subtitle-only tracks should style as Subtitle so the
                // existing `.kind-subtitle` CSS still applies. If the
                // track also has video, video wins.
                if !has_visual {
                    return "Subtitle".to_string();
                }
            }
        }
    }
    if has_visual {
        "Video".to_string()
    } else if has_audio {
        "Audio".to_string()
    } else {
        "Video".to_string()
    }
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

/// A/B-roll v2 V.7: right-click "Separate audio to new track" feature.
/// Lifts an Audio layer onto a freshly-created non-transient track
/// inserted directly after the source. Group membership preserved.
#[tauri::command]
pub async fn separate_audio_to_new_track(
    handle: State<'_, ProjectHandle>,
    layer_id: String,
) -> Result<String, String> {
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .separate_audio_to_new_track(Actor::User, id)
        .await
        .map(|t| t.to_string())
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn add_video_track(handle: State<'_, ProjectHandle>) -> Result<String, String> {
    // V.5: tracks are kind-agnostic. The legacy "add_video_track"
    // command keeps its name for IPC compatibility but produces a
    // generic track (no kind). Removed from the Insert menu in R.10
    // but the command stays callable for agent / test paths.
    let id = handle
        .add_track(Actor::User, Some("Track".into()))
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

    // V.5 (A/B-roll v2): tracks are kind-agnostic — any media drops on
    // the supplied target track directly. The old "route audio to an
    // audio track / image to an Overlay track" auto-re-routing is
    // gone; the IR routes by LayerParams discriminator, not track
    // kind, so layer placement no longer determines what stream it
    // contributes to.

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
        // V.5: the paired audio layer lands on the SAME track as the
        // video layer. V.2's overlap invariant accepts visual+audio
        // co-existence; the timeline renderer (V.6) combines them
        // into one row visually.
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
                track,
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
    // V.5: tracks are kind-agnostic, so demo color picks the first
    // existing track (typically A roll on a fresh project) or creates
    // one if the user has somehow dropped to zero tracks.
    let track_id = match snap.tracks.front() {
        Some(t) => t.id,
        None => handle
            .add_track(Actor::User, Some("Track".into()))
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
    // V.5: tracks are kind-agnostic; the demo text layer lands on
    // whichever track is at the top of z-stack (= last in
    // `project.tracks`). Falls back to a new track if zero exist.
    let snap = handle.snapshot().await;
    let track_id = match snap.tracks.last() {
        Some(t) => t.id,
        None => handle
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };
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
    crate::workspace::allow_workspace_fs(&app, &path);
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
    crate::workspace::allow_workspace_fs(&app, &path);
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
    crate::workspace::allow_workspace_fs(&app, &target);
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

// ---- App-level settings (A/B-roll redesign) ----
//
// Strict app-level scope (`docs/ab-roll-redesign`): every project opens
// under the same value. The pill / View menu / `T` shortcut all funnel
// here; the inline pill is the natural setting mutator and the Settings
// panel is mostly a reference UI.

#[tauri::command]
pub async fn app_settings_get(
    store: State<'_, crate::app_settings::AppSettingsStore>,
) -> Result<crate::app_settings::AppSettings, String> {
    Ok(store.get())
}

#[tauri::command]
pub async fn app_settings_set(
    app: tauri::AppHandle,
    store: State<'_, crate::app_settings::AppSettingsStore>,
    patch: crate::app_settings::AppSettingsPatch,
) -> Result<crate::app_settings::AppSettings, String> {
    let after = store.apply(patch).map_err(|e| format!("{e:#}"))?;
    // Fire-and-forget event so every UI subscriber re-renders. If a
    // listener isn't attached yet, the emit is a no-op — the next
    // `app_settings_get` (on first mount) will read the current value
    // anyway.
    use tauri::Emitter;
    let _ = app.emit("app_settings:changed", &after);
    Ok(after)
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

#[tauri::command]
pub async fn export_settings_get(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(ws) = workspace.current() else {
        return Ok(None);
    };
    Ok(crate::export_settings_store::load(&ws))
}

#[tauri::command]
pub async fn export_settings_set(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let Some(ws) = workspace.current() else {
        // Pre-workspace (blank-on-boot): silently drop, like view_state_set.
        return Ok(());
    };
    crate::export_settings_store::save(&ws, &settings).map_err(|e| format!("{e:#}"))
}

/// Absolute path of the current workspace (= project) directory, or null when
/// no project is open (blank-on-boot, pre-Save-As). The export dialog uses it
/// to default the output location to `<workspace>/output`.
#[tauri::command]
pub async fn workspace_dir(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
) -> Result<Option<String>, String> {
    Ok(workspace
        .current()
        .map(|p| p.to_string_lossy().into_owned()))
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
    let media_id = new_id();
    let workspace_root = workspace.current();
    let has_workspace = workspace_root.is_some();
    let item = tokio::task::spawn_blocking({
        let source_buf = source_buf.clone();
        let media_id = media_id;
        move || -> Result<MediaItem, String> {
            let (file_size, file_mtime, file_hash_blake3) = if has_workspace {
                let (size, mtime) = io::probe::stat_file(&source_buf)
                    .map_err(|e| format!("{e:#}"))?;
                (size, mtime, format!("pending-{media_id}"))
            } else {
                let facts = io::probe::hash_and_stat(&source_buf)
                    .map_err(|e| format!("{e:#}"))?;
                (facts.size, facts.mtime_secs, facts.blake3_hex)
            };
            let metadata = io::probe::probe_metadata(&source_buf);
            let kind: MediaKind = io::probe::detect_kind(&source_buf, &metadata);
            let label = source_buf
                .file_name()
                .map(|n| n.to_string_lossy().to_string());
            Ok(MediaItem {
                id: media_id,
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
                quick_proxy_path: None,
                proxy_bypassed: false,
                export_uses_original: false,
                waveform_path: None,
                thumbnails_dir: None,
                file_hash_blake3,
                file_size,
                file_mtime,
                imported_at: Utc::now(),
            })
        }
    })
    .await
    .map_err(|e| format!("import join: {e}"))??;

    let media_id = item.id;
    let item_for_jobs = item.clone();
    let id = handle
        .add_media_item(Actor::User, item)
        .await
        .map_err(|e: CommandError| e.to_string())?;

    // Derivative jobs read from `path_abs` (the original source) and are
    // content-addressed by hash. They can start immediately while the
    // workspace copy runs in the background.
    crate::jobs::enqueue_for_media(
        app.clone(),
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
    if let Some(ws) = workspace_root {
        import_queue.enqueue(
            (*handle).clone(),
            (*cache).clone(),
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

/// **Deprecated 2026-05-16.** R.3 / V.3's auto-track-creation on
/// import is gone — import is now a pool-only file operation. The
/// helper is preserved so its signature / structure is on record if
/// the auto-place flow is ever revived, but no live code path calls
/// it. Suppress the dead-code warning explicitly so cargo doesn't
/// flag it on every build.
#[allow(dead_code)]
async fn place_imported_media_on_fresh_tracks(
    app: &tauri::AppHandle,
    handle: &ProjectHandle,
    item: &MediaItem,
) -> Result<(), String> {
    use crate::logs;

    let media_id = item.id;
    // Default span when ffprobe couldn't give us a duration. Same fallback
    // shape as `add_media_layer` so the resulting layer is placeable and
    // trim-able even for unprobed sources.
    let total_src = item.metadata.duration_us.unwrap_or(2_000_000);
    let label = item
        .label
        .as_deref()
        .unwrap_or("Untitled")
        .to_string();
    // Trim the extension off the track label so "interview.mp4" reads as
    // "interview" in the timeline header.
    let track_label = std::path::Path::new(&label)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| label.clone());

    // V.5: tracks are kind-agnostic. We pick the right LayerParams
    // by MediaKind and pass a label for the track; no track-kind
    // routing.
    let (primary_params, primary_span) = match item.kind {
        MediaKind::Video => (
            LayerParams::VideoClip(state::layer::VideoClipParams {
                media: media_id,
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
                media: media_id,
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
                media: media_id,
                transform: Default::default(),
                opacity: Animated::Static(1.0),
                blend_mode: Default::default(),
                fade_in_us: 0,
                fade_out_us: 0,
            }),
            3_000_000,
        ),
        MediaKind::Subtitle => (
            LayerParams::Subtitles(SubtitlesParams {
                source: SubtitlesSource::Media(media_id),
            }),
            10_000_000,
        ),
    };

    // Primary track + layer. `add_transient_track` flags the track so
    // the actor's auto-prune sweep deletes it once the user drags the
    // imported layer off onto A/B (or deletes it). The reserved
    // role-stamped tracks aren't transient and survive.
    let primary_track_id = handle
        .add_transient_track(Actor::User, Some(track_label.clone()))
        .await
        .map_err(|e: CommandError| e.to_string())?;
    let primary_layer_id = handle
        .add_layer(
            Actor::User,
            primary_track_id,
            primary_params,
            0,
            primary_span,
        )
        .await
        .map_err(|e: CommandError| e.to_string())?;

    // Paired audio for video-with-audio imports. A/B-roll v2 (V.3): the
    // audio layer lands on the SAME transient track as the video, not
    // a separate audio track. The V.2 overlap invariant accepts V + A
    // at the same time slot on one track because they're different
    // overlap classes; the timeline renderer (V.6) collapses them into
    // a single combined row visually.
    if matches!(item.kind, MediaKind::Video)
        && item.metadata.audio.is_some()
    {
        let snap = handle.snapshot().await;
        if snap.settings.auto_pair_audio_on_import {
            let audio_params = LayerParams::Audio(state::layer::AudioParams {
                media: media_id,
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
                    primary_track_id,
                    audio_params,
                    0,
                    primary_span,
                )
                .await
                .map_err(|e: CommandError| e.to_string())?;
            // Group the V/A pair so future trims fan out
            // (`docs/group-system.md`). Same track placement means
            // the group acts as the "this is one logical clip"
            // signal; V.4's group-follow-on-move keeps them
            // co-located when the user drags the pair onto A or B.
            handle
                .groups_create(
                    Actor::User,
                    vec![primary_layer_id, audio_layer_id],
                    None,
                    false,
                )
                .await
                .map_err(|e: CommandError| e.to_string())?;
        }
    }

    // Surface the new track to the status console. The user is in AB mode
    // by default — without this entry an import looks like nothing
    // happened. Logged at Info so it's visible without being intrusive.
    logs::emit_via_app(
        app,
        logs::LogEntryInput {
            level: logs::LogLevel::Info,
            category: logs::LogCategory::Import,
            source: logs::LogSource::User,
            message: format!(
                "Added '{}' on a new track (hidden in A/B-Roll mode — switch to Show-All to see)",
                label
            ),
            details: Some(serde_json::json!({
                "mediaId": media_id.to_string(),
                "trackId": primary_track_id.to_string(),
            })),
            ..Default::default()
        },
    );

    Ok(())
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
    // V.5: tracks are kind-agnostic. Drop the subtitle layer on the
    // topmost track (last index = top of z-stack, where overlays
    // conventionally live).
    let track_id = match snap.tracks.last() {
        Some(t) => t.id,
        None => handle
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };
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

/// Serialize a manifest + its raw `html` into the picker payload shape (a
/// superset of the MCP `list_motifs`: every manifest field plus `html` for the
/// client-side preview). One helper so built-in and user Motifs emit the same
/// shape.
fn motif_to_payload(
    manifest: &crate::motifs::catalog::Manifest,
    html: String,
) -> Result<serde_json::Value, String> {
    let mut v = serde_json::to_value(manifest).map_err(|e| format!("manifest serialize: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "manifest is not a JSON object".to_string())?;
    obj.insert("html".to_string(), serde_json::Value::String(html));
    Ok(v)
}

/// Stage F-Picker: the UI catalog. A superset of the MCP `list_motifs`
/// payload — every manifest field (which now includes `engine` + `fonts`)
/// plus the raw `html` document so the picker can render live previews
/// client-side. The MCP surface stays manifest-only (see
/// `mcp::templates_payload`); the extra `html` field is UI-only and would
/// just bloat agent context.
///
/// Returns built-ins first (fixed display order), then on-disk user Motifs.
#[tauri::command]
pub async fn list_motifs(
    store: tauri::State<'_, crate::motifs::store::UserMotifStore>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    // Built-ins first (fixed display order), then on-disk user Motifs.
    for t in catalog::builtins() {
        out.push(motif_to_payload(&t.manifest, t.html)?);
    }
    for manifest in store.list_manifests() {
        let html = store.read_html(&manifest.id).unwrap_or_default();
        out.push(motif_to_payload(&manifest, html)?);
    }
    Ok(out)
}

/// Stage F-Picker: UI counterpart to the MCP `add_motif` tool. Mirrors
/// the behavior 1:1 (canonicalize props through the catalog module,
/// default `t_end_us` from manifest duration; when `track_id` is
/// omitted, always spawn a fresh "Overlay" track so consecutive
/// inserts never collide with each other on the same track). Only
/// the actor identity differs — `Actor::User` here vs.
/// `Actor::Agent { client: "mcp" }` there.
#[tauri::command]
pub async fn add_motif(
    handle: State<'_, ProjectHandle>,
    motif_id: String,
    t_start_us: TimeUs,
    t_end_us: Option<TimeUs>,
    track_id: Option<String>,
    props: Option<serde_json::Value>,
) -> Result<String, String> {
    let motif = catalog::builtins()
        .into_iter()
        .find(|t| t.id() == motif_id)
        .ok_or_else(|| {
            format!(
                "unknown motif_id '{motif_id}' — call list_motifs for the catalog",
            )
        })?;

    let provided = props.unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    let canonical = motif
        .canonicalize_props(&provided)
        .map_err(|e| format!("invalid props: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&canonical).map_err(|e| format!("canonical props parse: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "canonical props is not a JSON object".to_string())?;
    let props_map: imbl::HashMap<String, serde_json::Value> =
        obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

    // Resolve the end time (default-duration fallback + `max_duration_s` cap
    // clamp) via the shared helper so this command and the MCP `add_motif`
    // tool can't drift. The cap clamp here only bites explicit over-long
    // `t_end_us`; `add_layer` re-snaps both edges to the frame grid on entry.
    let resolved_end = crate::mcp::resolve_motif_t_end_us(
        t_start_us,
        t_end_us,
        motif.manifest.default_duration_s,
        // Cap is driven by the props being added (canonicalized above), so a
        // `max_duration_prop`-mapped motif clamps to its prop value.
        crate::motifs::catalog::resolve_motif_max_dur_us(&motif.manifest, &props_map),
    );
    if resolved_end <= t_start_us {
        return Err(format!(
            "t_end_us {resolved_end} must be greater than t_start_us {t_start_us}",
        ));
    }

    let track = match track_id {
        Some(s) => Uuid::parse_str(&s).map_err(|e| format!("track_id: {e}"))?,
        None => handle
            // Every auto-routed motif insert gets its own track.
            // Reusing an existing "Overlay" track would re-trip the
            // per-track no-overlap invariant the moment a second
            // motif is added at a colliding range.
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };

    let params = LayerParams::Motif(MotifParams {
        motif_id: motif.id().to_string(),
        motif_version: motif.manifest.version,
        props: props_map,
        src_in_us: 0,
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

// groups_set_effects / layers_set_effects commands removed in P12-a.
// The Pixi renderer doesn't read effects; the mutation surface for
// them is dead in v1. P12-b deletes the Layer::effects / Group::effects
// fields proper, alongside the IR visual half.

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
pub async fn fit_composition_to_layers(
    handle: State<'_, ProjectHandle>,
) -> Result<(), String> {
    handle
        .fit_composition_to_layers(Actor::User)
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

/// Audio-only export. AWAITABLE (not fire-and-forget) — App.tsx
/// awaits this between the Pixi Worker video export and the final
/// stream-copy mux. Emits no `export:*` events so the ExportPanel
/// state stays under the JS orchestrator's control.
#[tauri::command]
pub async fn export_project_audio_only(
    app: tauri::AppHandle,
    handle: State<'_, ProjectHandle>,
    output_path: String,
    audio: crate::export::AudioEncodeSpec,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<(), String> {
    let snap = handle.snapshot().await;
    let project = (*snap).clone();
    let path = PathBuf::from(output_path);
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    export::export_audio_only(app, &project, &path, &audio, window)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Transcode spec for the ffmpeg export path. Absent ⇒ stream-copy mux.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeSpec {
    pub video_codec: String, // "h264" | "hevc" | "av1" | "vp9"
    pub bitrate: u64,
    pub cbr: bool,
    pub duration_us: i64,
    pub gop: u64, // frames between keyframes (ffmpeg -g)
    #[serde(default)]
    pub software: bool, // force a software encoder instead of HW-first
}

/// Mux `video_path` + `audio_path` into `output_path`. With no `transcode`,
/// stream-copies (`-c copy`). With a `transcode`, re-encodes the video to the
/// target codec (HW encoder first, software fallback) and emits
/// `export:transcode_progress` events. Container = the output extension.
#[tauri::command]
pub async fn mux_export(
    app: tauri::AppHandle,
    hw_cache: State<'_, crate::export::HwEncoderCache>,
    video_path: String,
    audio_path: String,
    output_path: String,
    transcode: Option<TranscodeSpec>,
) -> Result<(), String> {
    let video = PathBuf::from(video_path);
    let audio = PathBuf::from(audio_path);
    let out = PathBuf::from(output_path);
    // Ensure the output directory exists (the export dialog defaults the
    // location to `<workspace>/output`, which may not exist yet).
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create output dir {}: {e}", parent.display()))?;
    }
    match transcode {
        None => export::mux_to_file(&video, &audio, &out)
            .await
            .map_err(|e| format!("{e:#}")),
        Some(spec) => {
            let codec = crate::export::TargetCodec::parse(&spec.video_codec)
                .ok_or_else(|| format!("unknown codec {}", spec.video_codec))?;
            // "software" forces the CPU encoder; otherwise HW-first (cached probe).
            let encoder: String = if spec.software {
                codec.software_encoder().to_string()
            } else {
                (*hw_cache.encoder_for(codec).await).clone()
            };
            export::transcode_and_mux(
                &app,
                &encoder,
                codec,
                spec.bitrate,
                spec.cbr,
                spec.gop,
                spec.duration_us,
                &video,
                &audio,
                &out,
            )
            .await
            .map_err(|e| format!("{e:#}"))
        }
    }
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

/// Ensure a full export proxy exists/queued for a media item. Idempotent: a
/// Enqueue the full export proxy for `media_id` and route-correct it: clears
/// `export_uses_original` so the resolvers stop pointing export at the
/// (undecodable) original while the proxy encodes. No-op if a full proxy is
/// already present. Invoked by the import-time decodability sweep, the export
/// pre-flight, and the future per-clip "Generate proxy" action.
#[tauri::command]
pub async fn ensure_full_proxy(
    app: tauri::AppHandle,
    cache: State<'_, crate::cache::CacheLayout>,
    handle: State<'_, ProjectHandle>,
    media_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    // Already have a full proxy on disk → nothing to do (the proxy already
    // shadows `export_uses_original` in the resolvers).
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return Ok(());
    }
    // Route correction: this source was routed to DirectExport
    // (export_uses_original) but cannot be decoded directly on this machine.
    // Demote it to a normal full-proxy source BEFORE enqueuing, so the
    // resolvers stop pointing export at the undecodable original and the gentle
    // "preparing" path applies while the proxy encodes. See ADR 0010 + the
    // import-time-decodability-probe design.
    handle
        .set_media_derivatives(
            Actor::Agent {
                client: "jobs".to_string(),
            },
            id,
            state::MediaDerivativesPatch {
                export_uses_original: Some(false),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("route-correct {media_id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(app, (*cache).clone(), (*handle).clone(), item);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motif_payload_includes_manifest_fields_and_html() {
        let m = crate::motifs::catalog::builtin_countdown();
        let v = motif_to_payload(&m.manifest, m.html.clone()).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.get("id").unwrap(), "countdown");
        assert!(obj.get("html").unwrap().as_str().unwrap().contains("motif.define"));
        assert!(obj.contains_key("size"));
        assert!(obj.contains_key("props_schema"));
    }
}
